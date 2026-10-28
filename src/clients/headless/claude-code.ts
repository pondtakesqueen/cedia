// Runs one role step through the user's own Claude Code CLI, so the plan and review roles can use their Claude
// subscription the way Anthropic allows: by running Claude Code itself. cedia never reads or sends its
// credentials. The step is read-only by Claude Code's own rules: only the listed tools exist, and dontAsk denies
// anything not pre-approved. It runs restricted: the repository under review must not run code outside cedia's
// sandbox, so Claude Code reads no settings file (a repo's .claude/settings.json hooks, the user's plugins), starts
// no MCP server (.mcp.json) and loads no custom commands; its file tools stay in the working directory. The login
// is untouched (unlike --bare, which reads no keychain).
//
// The prompt goes in on stdin (stream-json), so a step can start before its prompt is known: Claude Code takes
// seconds to start (4.7 s from spawn to its first request on 2026-10-28, against 0.16 s from the prompt to the
// request once started), and the run spends them while the triage or the writer works instead of after.

export type ClaudeCodeStep = { prompt: string; model: string; effort?: string; cwd: string; allowed: string[]; signal?: AbortSignal; gitStatus?: boolean };
export type ClaudeCodeResult = { ok: boolean; text: string; sessionId: string; costUsd?: number; turns?: number; apiMs?: number; error?: string };
// A step started ahead of its prompt: run it once, or cancel it before any request is sent.
export type WarmClaudeCode = { run(prompt: string): Promise<ClaudeCodeResult>; cancel(): void };

// Keys that would switch Claude Code from the subscription to API billing, and cedia's own settings.
const STRIPPED = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CEDIA_.*|OPENCODE_API_KEY|DEEPSEEK_API_KEY)$/;

export function claudeCodeArgs(step: Omit<ClaudeCodeStep, 'prompt'>): string[] {
  const tools = [...new Set(step.allowed.map((a) => a.replace(/\(.*$/, '')))];
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', step.model, ...(step.effort ? ['--effort', step.effort] : []), '--tools', tools.join(','), '--permission-mode', 'dontAsk', '--no-session-persistence', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--allowedTools', ...step.allowed];
}

export function claudeCodeEnv(step: Pick<ClaudeCodeStep, 'gitStatus'>, from: Record<string, string | undefined> = process.env): Record<string, string> {
  const env = Object.fromEntries(Object.entries(from).filter((e): e is [string, string] => e[1] !== undefined && !STRIPPED.test(e[0])));
  // Claude Code snapshots git status when it starts, not when the prompt comes: a step started before the writer
  // changed anything would be told the tree is as it was. Such a step goes without the snapshot (and the commit and
  // PR instructions that come with it, which a read-only step has no use for); it reads git status when it needs to.
  if (step.gitStatus === false) env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '1';
  return env;
}

export function startClaudeCode(step: Omit<ClaudeCodeStep, 'prompt'>, bin = process.env.CEDIA_CLAUDE_BIN ?? 'claude'): WarmClaudeCode {
  const spawn = () => Bun.spawn([bin, ...claudeCodeArgs(step)], { cwd: step.cwd, env: claudeCodeEnv(step), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', ...(step.signal ? { signal: step.signal } : {}) });
  let proc: ReturnType<typeof spawn> | undefined;
  let failed: string | undefined;
  try {
    proc = spawn();
  } catch (e) {
    failed = `could not start ${bin}: ${(e as Error).message}`;
  }
  // Read from the start, so a step that writes before its prompt never blocks on a full pipe.
  const output = proc ? Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]) : undefined;
  output?.catch(() => {});
  let used = false;
  return {
    cancel() {
      if (!used) proc?.kill();
      used = true;
    },
    async run(prompt) {
      if (used) return { ok: false, text: '', sessionId: '', error: 'this Claude Code step already ran' };
      used = true;
      if (!proc || !output) return { ok: false, text: '', sessionId: '', error: failed ?? `could not start ${bin}` };
      try {
        proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
        await proc.stdin.end();
      } catch {
        // it exited before reading: what it printed says why
      }
      const [stdout, stderr, code] = await output;
      return parseResult(stdout, stderr, code, bin);
    },
  };
}

export const runClaudeCode = (step: ClaudeCodeStep, bin?: string): Promise<ClaudeCodeResult> => startClaudeCode(step, bin).run(step.prompt);

// The result event is the last line Claude Code prints; the lines before it are the session's messages.
function parseResult(stdout: string, stderr: string, code: number, bin: string): ClaudeCodeResult {
  let j: Record<string, unknown> | undefined;
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'result') j = parsed;
    } catch {
      // not JSON: reported below
    }
    if (j) break;
  }
  if (!j) return { ok: false, text: '', sessionId: '', error: `${bin} exited ${code}: ${(stderr || stdout).trim().slice(-500)}` };
  const ok = j.subtype === 'success' && j.is_error !== true;
  return {
    ok,
    text: String(j.result ?? ''),
    sessionId: String(j.session_id ?? ''),
    ...(typeof j.total_cost_usd === 'number' ? { costUsd: j.total_cost_usd } : {}),
    ...(typeof j.num_turns === 'number' ? { turns: j.num_turns } : {}),
    ...(typeof j.duration_api_ms === 'number' ? { apiMs: j.duration_api_ms } : {}),
    ...(ok ? {} : { error: String(j.result ?? j.subtype) }),
  };
}
