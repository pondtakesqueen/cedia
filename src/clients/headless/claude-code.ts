// Runs one role step through the user's own Claude Code CLI, so the plan and review roles can use their Claude
// subscription the way Anthropic allows: by running Claude Code itself. cedia never reads or sends its
// credentials. The step is read-only by Claude Code's own rules: only the listed tools exist, and dontAsk denies
// anything not pre-approved. It runs restricted: the repository under review must not run code outside cedia's
// sandbox, so Claude Code reads no settings file (a repo's .claude/settings.json hooks, the user's plugins), starts
// no MCP server (.mcp.json) and loads no custom commands; its file tools stay in the working directory. The login
// is untouched (unlike --bare, which reads no keychain).

export type ClaudeCodeStep = { prompt: string; model: string; cwd: string; allowed: string[]; signal?: AbortSignal };
export type ClaudeCodeResult = { ok: boolean; text: string; sessionId: string; costUsd?: number; error?: string };

// Keys that would switch Claude Code from the subscription to API billing, and cedia's own settings.
const STRIPPED = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CEDIA_.*|OPENCODE_API_KEY|DEEPSEEK_API_KEY)$/;

export function claudeCodeArgs(step: ClaudeCodeStep): string[] {
  const tools = [...new Set(step.allowed.map((a) => a.replace(/\(.*$/, '')))];
  return ['-p', step.prompt, '--output-format', 'json', '--model', step.model, '--tools', tools.join(','), '--permission-mode', 'dontAsk', '--no-session-persistence', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--allowedTools', ...step.allowed];
}

export async function runClaudeCode(step: ClaudeCodeStep, bin = process.env.CEDIA_CLAUDE_BIN ?? 'claude'): Promise<ClaudeCodeResult> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED.test(k))) as Record<string, string>;
  let proc;
  try {
    proc = Bun.spawn([bin, ...claudeCodeArgs(step)], { cwd: step.cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', ...(step.signal ? { signal: step.signal } : {}) });
  } catch (e) {
    return { ok: false, text: '', sessionId: '', error: `could not start ${bin}: ${(e as Error).message}` };
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let j: Record<string, unknown> | undefined;
  try {
    j = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    // not JSON: reported below
  }
  if (!j || j.type !== 'result') return { ok: false, text: '', sessionId: '', error: `${bin} exited ${code}: ${(stderr || stdout).trim().slice(-500)}` };
  const ok = j.subtype === 'success' && j.is_error !== true;
  return {
    ok,
    text: String(j.result ?? ''),
    sessionId: String(j.session_id ?? ''),
    ...(typeof j.total_cost_usd === 'number' ? { costUsd: j.total_cost_usd } : {}),
    ...(ok ? {} : { error: String(j.result ?? j.subtype) }),
  };
}
