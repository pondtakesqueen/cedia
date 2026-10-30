import { clip, MAX_SHELL_OUTPUT_CHARS, preview, type ToolSpec } from './registry.ts';
import { summarizeTestFailures } from './testfail.ts';
import { SECRET_ENV } from '../safety/secrets.ts';

// A command counts as read-only when every command in its pipeline, && chain or ; list is on this list (or is a
// `cd`) and nothing writes, substitutes or redirects. Read-only commands run in parallel and in read-only sessions;
// anything else is an `exec` call that the permission policy decides.

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo', 'sort', 'uniq', 'cut', 'tr',
  'file', 'stat', 'du', 'which', 'date', 'uname', 'basename', 'dirname', 'realpath', 'tree', 'diff', 'sed', 'awk', 'jq', 'git', 'true',
  'nl', 'od',
]);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'remote', 'describe', 'shortlog', 'grep']);
// Flags that write a file or run another program (a preprocessor, a pager, a compressor, a diff driver).
const FORBIDDEN_FLAGS: Record<string, RegExp> = {
  find: /^-(exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  // Short flags may come bundled (`-ni`), so a letter anywhere in the bundle counts.
  sed: /^(-[A-Za-z]*[if]|--in-place|--file)/,
  awk: /^(-i|-f|-E|-l|--include|--file|--exec|--load)/,
  sort: /^(-[A-Za-z]*o|--output|--compress-program)/,
  rg: /^--pre(=|$)/,
  date: /^(-s|--set)/,
  tree: /^-[A-Za-z]*[oR]/,
  file: /^(-[A-Za-z]*C|--compile)/,
  git: /^(-c|--exec-path|--output|-O|--open-files-in-pager|--ext-diff|--textconv)/,
};

export type Verdict = { ok: true } | { ok: false; reason: string };

export function splitWords(segment: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) words.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (quote) return null;
  if (cur || has) words.push(cur);
  return words;
}

// Strips quoted text and the two harmless redirections (2>&1, 2>/dev/null), leaving the operators that matter.
const bareOf = (command: string) =>
  command
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/(^|\s)\d?>&\d(?=[\s;|&]|$)/g, ' ')
    .replace(/(^|\s)2>\s*\/dev\/null(?=[\s;|&]|$)/g, ' ');

// True when the command writes a file through `>`, `>>` or `&>`, which the split argv no longer shows.
export const redirectsOutput = (command: string): boolean => />/.test(bareOf(command));

export function checkReadOnly(command: string): Verdict {
  if (/`|\$\(|<\(|>\(/.test(command)) return { ok: false, reason: 'command substitution is not allowed' };
  // Look for operators outside quotes, so `grep "a>b"` is fine.
  const bare = bareOf(command);
  if (/[<>]/.test(bare) || bare.replace(/&&/g, '').includes('&')) return { ok: false, reason: 'redirection and background jobs are not allowed' };
  const original = splitTopLevel(command);
  if (!original) return { ok: false, reason: 'unbalanced quotes' };
  for (const seg of original) {
    const words = splitWords(seg.trim());
    if (!words?.length) return { ok: false, reason: 'empty command' };
    const [cmd, ...args] = words;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd!)) return { ok: false, reason: 'environment assignments are not allowed' };
    // `cd <dir> && cat x` only reads: models lead most commands with a cd to the working directory. The policy reads
    // the paths after it from the directory it names, so only a plain directory is taken.
    if (cmd === 'cd') {
      if (args.length > 1 || args.some((a) => a.startsWith('-') || a.includes('$'))) return { ok: false, reason: 'cd takes one plain directory here' };
      continue;
    }
    if (!READ_ONLY.has(cmd!)) return { ok: false, reason: `"${cmd}" is not on the read-only list` };
    const bad = FORBIDDEN_FLAGS[cmd!];
    if (bad && args.some((a) => bad.test(a))) return { ok: false, reason: `"${cmd}" with that flag can write` };
    if (cmd === 'git') {
      // `git -C <dir> status`: the word after -C is a directory, not the subcommand.
      let i = 0;
      while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' ? 2 : 1;
      const sub = args[i];
      if (!sub || !GIT_READ.has(sub)) return { ok: false, reason: `git ${sub ?? ''} is not read-only` };
      if (sub === 'branch' && args.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream)/.test(a))) return { ok: false, reason: 'git branch with that flag writes' };
      if (sub === 'remote' && args.some((a) => /^(add|remove|rm|rename|set-url|prune|update)$/.test(a))) return { ok: false, reason: 'git remote with that subcommand writes' };
    }
    // Any pipe but `||` runs a command, whatever names it (`print | cmd`), and any `>` after a print may redirect it.
    if (cmd === 'awk' && args.some((a) => /system\s*\(|\bprintf?\b[^;{}]*>|(^|[^|])\|(?!\|)/.test(a))) return { ok: false, reason: 'awk program can write or run commands' };
    // uniq writes its output to a second file name.
    if (cmd === 'uniq' && args.filter((a) => !a.startsWith('-')).length > 1) return { ok: false, reason: 'uniq with an output file writes' };
    if (cmd === 'sed' && args.some((a) => /(^|;)\s*[0-9,$]*\s*[wWe]\b|\/[wW]\s/.test(a) || sedSubstituteRuns(a))) return { ok: false, reason: 'sed script can write or run commands' };
  }
  return { ok: true };
}

// An `s` command with the e flag runs its result as a command, and with w writes a file, whatever the delimiter
// (`s|a|b|gw out`).
const sedSubstituteRuns = (script: string) =>
  [...script.matchAll(/s([^\s\w\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1([A-Za-z0-9]*)/g)].some((m) => /[ewW]/.test(m[2]!));

// Splits on |, ||, &&, ; and newlines outside quotes. A ; or newline that ends the command, or follows another,
// leaves no empty command behind.
function splitTopLevel(command: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let soft = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') {
        cur += ch + (command[++i] ?? '');
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if ((ch === '|' || ch === '&') && (command[i + 1] === ch || ch === '|')) {
      out.push(cur);
      cur = '';
      soft = false;
      if (command[i + 1] === ch) i++;
    } else if (ch === ';' || ch === '\n') {
      if (cur.trim() || !soft) out.push(cur);
      cur = '';
      soft = true;
    } else {
      cur += ch;
      if (ch.trim()) soft = false;
    }
  }
  if (quote) return null;
  if (cur.trim() || !soft) out.push(cur);
  return out;
}

// Commands never see cedia's own credentials: provider keys and anything that looks like a secret stay out.
// Shell startup files stay out too: bash is spawned --noprofile --norc, and the variables that would point it
// at a startup file anyway (BASH_ENV, ENV, ZDOTDIR) are stripped, so a repository cannot run code before the
// command by planting one (Claude Code 2.1.309 ran startup files outside the sandbox).
// Git's environment config (GIT_CONFIG_COUNT with GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n) goes as one: a value
// can be a credential header, and a count left without its keys makes every git command fail.
const SHELL_STARTUP = new Set(['BASH_ENV', 'ENV', 'ZDOTDIR']);
const GIT_ENV_CONFIG = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
export function scrubbedEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !SECRET_ENV.test(e[0]) && !SHELL_STARTUP.has(e[0]) && !GIT_ENV_CONFIG.test(e[0]) && !e[0].startsWith('CEDIA_')),
  );
}

// What the model's commands run with: the scrubbed environment, and Python told not to leave __pycache__ beside
// the code a test run imports (a panel marked those files down as stray in a diff, 2026-10-28-opus-quality), unless
// the user's own environment already says.
export const commandEnv = (env: Record<string, string | undefined> = process.env): Record<string, string> => ({ PYTHONDONTWRITEBYTECODE: '1', ...scrubbedEnv(env) });

const PIPE_GRACE_MS = 500;

// Reads a pipe as it fills, so what arrived is there to return even when the pipe never closes.
function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const done = (async () => {
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) text += decoder.decode(r.value, { stream: true });
    } catch {
      // cancelled by stop()
    }
  })();
  const stop = () => {
    reader.cancel().catch(() => {});
    return text + decoder.decode();
  };
  return { done, stop };
}

// Most models keep searching with `grep -r` in bash even with the grep tool offered (Flash called it 4 times
// against 25 recursive greps in a gate run), and on a large tree that reads build output and dependencies: 22 s
// where rg took 0.16 s. A recursive grep that took a while says so in its result, so the next search uses the tool.
const RECURSIVE_GREP = /(^|[|&;(\s])e?grep\s+([^|&;]*\s)?(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)(\s|$)/;
export const SLOW_GREP_MS = 2000;
export const slowGrepNote = (command: string, ms: number) =>
  ms >= SLOW_GREP_MS && RECURSIVE_GREP.test(command)
    ? `\n[this recursive grep took ${(ms / 1000).toFixed(1)} s: the grep tool skips what .gitignore excludes and is usually far faster]`
    : '';

export const bashTool: ToolSpec = {
  name: 'bash',
  description:
    'Run a shell command with bash in the working directory and return its output and exit code. Use it to build, run tests and run commands; search file contents with the grep tool, not grep -r. A command the permission policy denies is not run; the result says why.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  effect: 'exec',
  replay: 'unsafe',
  effectOf: (input) => (checkReadOnly(String(input.command ?? '')).ok ? 'read' : 'exec'),
  async run(input, ctx) {
    const command = String(input.command ?? '');
    // A timeout that is not a positive number (a string such as "5m", 0) would end the command at once.
    const asked = Number(input.timeout_ms);
    const timeout = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 120_000, 600_000);
    const script = ctx.wrap ? await ctx.wrap(command) : command;
    // Its own process group, so a timeout or an abort ends what the command started too, not only bash.
    const started = Date.now();
    // --noprofile --norc (with BASH_ENV/ENV/ZDOTDIR scrubbed above): no startup file runs, inside the
    // sandbox or out, so a planted one cannot run code before the command.
    const proc = Bun.spawn(['bash', '--noprofile', '--norc', '-c', script], { cwd: ctx.cwd, env: commandEnv(), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', detached: true });
    let stopped = '';
    const kill = (why: string) => () => {
      stopped ||= why;
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    };
    const onAbort = kill('aborted');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    const timer = setTimeout(kill(`timed out after ${timeout} ms`), timeout);
    const out = drain(proc.stdout);
    const err = drain(proc.stderr);
    const code = await proc.exited;
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
    // A background job the command left running (`server &`) keeps the pipes open after bash exits: wait a
    // moment for the output, then return without it rather than wait for the job.
    await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(PIPE_GRACE_MS)]);
    const [o, e] = [out.stop(), err.stop()];
    const text = [o, e && `[stderr]\n${e}`].filter(Boolean).join('\n') || '(no output)';
    // A group that outlives its bash (a `&` job, nohup) is left running — killing it would end servers the
    // run started on purpose — so the result says so instead, and the model can jobs or kill it itself.
    // Recording it for `cedia agents` would need the thread, which tools never see: deferred.
    let lingering = false;
    try {
      process.kill(-proc.pid, 0);
      lingering = true;
    } catch {}
    const full = `${text}\n[exit ${code}${stopped ? `, ${stopped}` : ''}]${lingering ? ' (background jobs of this command are still running)' : ''}${slowGrepNote(command, Date.now() - started)}`;
    // A long output goes to a file whole, so the lines in the middle (often the failing test) are still there.
    const path = full.length > MAX_SHELL_OUTPUT_CHARS ? ctx.spill?.(full) : undefined;
    // A long check's failures ride the result instead of its head and tail, so the fix sees them first.
    const failures = path ? summarizeTestFailures(command, full) : undefined;
    if (path && failures) return { text: `${failures}\n\nThe whole output (${full.length} characters) is in ${path}: grep it, or read it with offset and limit.`, isError: code !== 0, exitCode: code, spillPath: path };
    if (path) return { text: preview(full, path, MAX_SHELL_OUTPUT_CHARS), isError: code !== 0, exitCode: code, spillPath: path };
    return { text: clip(full, MAX_SHELL_OUTPUT_CHARS), isError: code !== 0, exitCode: code };
  },
};
