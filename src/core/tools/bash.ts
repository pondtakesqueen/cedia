import { clip, MAX_OUTPUT_CHARS, preview, type ToolSpec } from './registry.ts';

// A command counts as read-only when every command in its pipeline or && chain is on this list and
// nothing writes, substitutes or redirects. Read-only commands run in parallel and in read-only sessions;
// anything else is an `exec` call that the permission policy decides.

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo', 'sort', 'uniq', 'cut', 'tr',
  'file', 'stat', 'du', 'which', 'date', 'uname', 'basename', 'dirname', 'realpath', 'tree', 'diff', 'sed', 'awk', 'jq', 'git', 'true',
]);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'remote', 'describe', 'shortlog', 'grep']);
const FORBIDDEN_FLAGS: Record<string, RegExp> = {
  find: /^-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)$/,
  sed: /^(-i|--in-place)/,
  awk: /^-i/,
  sort: /^(-o|--output)/,
  git: /^(-c|--exec-path|--output)/,
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
    .replace(/(^|\s)\d?>&\d(?=\s|$)/g, ' ')
    .replace(/(^|\s)2>\s*\/dev\/null(?=\s|$)/g, ' ');

// True when the command writes a file through `>`, `>>` or `&>`, which the split argv no longer shows.
export const redirectsOutput = (command: string): boolean => />/.test(bareOf(command));

export function checkReadOnly(command: string): Verdict {
  if (/[`\n]|\$\(|<\(|>\(/.test(command)) return { ok: false, reason: 'command substitution and newlines are not allowed' };
  // Look for operators outside quotes, so `grep "a>b"` is fine.
  const bare = bareOf(command);
  if (/[<>;]/.test(bare) || bare.replace(/&&/g, '').includes('&')) return { ok: false, reason: 'redirection, background jobs and ; are not allowed' };
  const original = splitTopLevel(command);
  if (!original) return { ok: false, reason: 'unbalanced quotes' };
  for (const seg of original) {
    const words = splitWords(seg.trim());
    if (!words?.length) return { ok: false, reason: 'empty command' };
    const [cmd, ...args] = words;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd!)) return { ok: false, reason: 'environment assignments are not allowed' };
    if (!READ_ONLY.has(cmd!)) return { ok: false, reason: `"${cmd}" is not on the read-only list` };
    const bad = FORBIDDEN_FLAGS[cmd!];
    if (bad && args.some((a) => bad.test(a))) return { ok: false, reason: `"${cmd}" with that flag can write` };
    if (cmd === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (!sub || !GIT_READ.has(sub)) return { ok: false, reason: `git ${sub ?? ''} is not read-only` };
      if (sub === 'branch' && args.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream)/.test(a))) return { ok: false, reason: 'git branch with that flag writes' };
      if (sub === 'remote' && args.some((a) => /^(add|remove|rm|rename|set-url|prune|update)$/.test(a))) return { ok: false, reason: 'git remote with that subcommand writes' };
    }
    if (cmd === 'awk' && args.some((a) => /system\s*\(|print\s*>|\|\s*"/.test(a))) return { ok: false, reason: 'awk program can write or run commands' };
    if (cmd === 'sed' && args.some((a) => /(^|;)\s*[0-9,$]*\s*[wWe]\b|\/[wW]\s/.test(a))) return { ok: false, reason: 'sed script can write or run commands' };
  }
  return { ok: true };
}

// Splits on |, ||, && outside quotes.
function splitTopLevel(command: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
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
      if (command[i + 1] === ch) i++;
    } else cur += ch;
  }
  if (quote) return null;
  out.push(cur);
  return out;
}

// Commands never see cedia's own credentials: provider keys and anything that looks like a secret stay out.
// Git's environment config (GIT_CONFIG_COUNT with GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n) goes as one: a value
// can be a credential header, and a count left without its keys makes every git command fail.
const SECRET = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)($|_)/i;
const GIT_ENV_CONFIG = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
export function scrubbedEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !SECRET.test(e[0]) && !GIT_ENV_CONFIG.test(e[0]) && !e[0].startsWith('CEDIA_')),
  );
}

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

export const bashTool: ToolSpec = {
  name: 'bash',
  description:
    'Run a shell command with bash in the working directory and return its output and exit code. Use it to search, build and run tests. A command the permission policy denies is not run; the result says why.',
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
    const timeout = Math.min(Number(input.timeout_ms ?? 120_000), 600_000);
    const script = ctx.wrap ? await ctx.wrap(command) : command;
    // Its own process group, so a timeout or an abort ends what the command started too, not only bash.
    const proc = Bun.spawn(['bash', '-c', script], { cwd: ctx.cwd, env: scrubbedEnv(), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', detached: true });
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
    const full = `${text}\n[exit ${code}${stopped ? `, ${stopped}` : ''}]`;
    // A long output goes to a file whole, so the lines in the middle (often the failing test) are still there.
    const path = full.length > MAX_OUTPUT_CHARS ? ctx.spill?.(full) : undefined;
    if (path) return { text: preview(full, path), isError: code !== 0, exitCode: code, spillPath: path };
    return { text: clip(full), isError: code !== 0, exitCode: code };
  },
};
