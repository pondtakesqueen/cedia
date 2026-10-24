import { isAbsolute, join } from 'node:path';
import type { HookInput } from '../hooks.ts';
import type { JsonObject } from '../types.ts';

// Hooks written for Claude Code, run by cedia's hooks (core/hooks.ts) through this adapter: the call goes to the
// hook in Claude Code's shape (tool names like Bash and Edit, `tool_input` with `file_path`), and its answer
// (exit 2, or JSON with `permissionDecision`, `decision`, `additionalContext`, `updatedInput`) comes back as
// cedia's. Only command hooks of PreToolUse, PostToolUse and Stop are adapted; the plugin installer lists the rest
// as skipped.
//
// A plugin's hooks fail as Claude Code's do, since their authors wrote them for that: an exit other than 0 or 2,
// or a hook that cannot start or runs too long, lets the step go on, unless the hook says `onFailure: "block"`.
// They run in the plugin's folder with CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and CLAUDE_PROJECT_DIR set.

export type ClaudeHook = {
  plugin: string;
  root: string;
  data: string;
  // Exec form (`command` + `args`, ${CLAUDE_*} filled in by cedia) or shell form (`sh -c <command>`; the shell
  // expands them from the environment).
  form: 'exec' | 'shell';
  matcher?: string;
  onFailure?: 'continue' | 'block';
};

const NAMES: Record<string, string> = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', grep: 'Grep', web_fetch: 'WebFetch', web_search: 'WebSearch', todo: 'TodoWrite', spawn: 'Agent', ask_user: 'AskUserQuestion' };

// The name Claude Code gives the tool; an MCP tool keeps its mcp__server__tool name, as Claude Code's does.
export const claudeToolName = (tool: string) => NAMES[tool] ?? tool;

// Claude Code's matcher: empty or `*` matches all; letters, digits, `_`, `-`, spaces, `,` and `|` are a list of
// exact names; anything else is an unanchored regular expression.
export function claudeMatches(matcher: string | undefined, tool: string): boolean {
  const m = (matcher ?? '').trim();
  if (!m || m === '*') return true;
  const name = claudeToolName(tool);
  if (/^[\w\s,|-]+$/.test(m)) return m.split(/[|,]/).some((n) => n.trim() === name);
  try {
    return new RegExp(m).test(name);
  } catch {
    return false;
  }
}

const abs = (p: unknown, cwd: string) => (typeof p === 'string' ? (isAbsolute(p) ? p : join(cwd, p)) : p);

// cedia's input for a tool as Claude Code's would be.
export function claudeToolInput(tool: string, input: JsonObject, cwd: string): JsonObject {
  switch (tool) {
    case 'bash':
      return { command: input.command ?? '', ...(input.timeout_ms !== undefined ? { timeout: input.timeout_ms } : {}) };
    case 'read':
      return { file_path: abs(input.path, cwd) ?? '', ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) };
    case 'write':
      return { file_path: abs(input.path, cwd) ?? '', content: input.content ?? '' };
    case 'edit': {
      const edits = (Array.isArray(input.edits) ? input.edits : []) as JsonObject[];
      const one = (e: JsonObject) => ({ old_string: e.old_text ?? '', new_string: e.new_text ?? '', replace_all: e.replace_all === true });
      return { file_path: abs(input.path, cwd) ?? '', ...(edits.length === 1 ? one(edits[0]!) : { edits: edits.map(one) }) };
    }
    default:
      return input;
  }
}

// A hook's updatedInput back in cedia's shape, over the call's own input so fields cedia has and Claude Code
// lacks stay.
export function cediaToolInput(tool: string, updated: JsonObject, input: JsonObject): JsonObject {
  const str = (v: unknown) => typeof v === 'string';
  switch (tool) {
    case 'bash':
      return { ...input, ...(str(updated.command) ? { command: updated.command } : {}), ...(typeof updated.timeout === 'number' ? { timeout_ms: updated.timeout } : {}) };
    case 'read':
    case 'write':
      return { ...input, ...(str(updated.file_path) ? { path: updated.file_path } : {}), ...(tool === 'write' && str(updated.content) ? { content: updated.content } : {}) };
    case 'edit': {
      const list = Array.isArray(updated.edits) ? (updated.edits as JsonObject[]) : str(updated.old_string) ? [updated] : undefined;
      const edits = list?.map((e) => ({ old_text: e.old_string ?? '', new_text: e.new_string ?? '', ...(e.replace_all === true ? { replace_all: true } : {}) }));
      return { ...input, ...(str(updated.file_path) ? { path: updated.file_path } : {}), ...(edits ? { edits } : {}) };
    }
    default:
      return updated;
  }
}

// What a Claude Code hook is handed on stdin.
export function claudeHookInput(input: HookInput): JsonObject {
  const common = { session_id: input.sessionId, transcript_path: '', cwd: input.cwd, permission_mode: 'default' };
  if (input.event === 'stop') return { ...common, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: input.result };
  const call = { tool_name: claudeToolName(input.tool), tool_input: claudeToolInput(input.tool, input.input, input.cwd), tool_use_id: input.callId };
  if (input.event === 'preToolUse') return { ...common, hook_event_name: 'PreToolUse', ...call };
  const response =
    input.tool === 'bash'
      ? { stdout: input.output.text, stderr: '', interrupted: false, isImage: false, ...(input.output.exitCode !== undefined ? { exit_code: input.output.exitCode } : {}) }
      : { output: input.output.text, success: !input.output.isError, ...('file_path' in call.tool_input ? { filePath: call.tool_input.file_path } : {}) };
  return { ...common, hook_event_name: 'PostToolUse', ...call, tool_response: response };
}

// What the hook's exit and output mean, before cedia caps and makes inert the text in it. `failed`: the hook
// did not work, which lets the step go on unless it asked to block on failure.
export type ClaudeAnswer =
  | { decision: 'allow'; updatedInput?: JsonObject; note?: string }
  | { decision: 'block'; reason: string; failed?: boolean };

export function claudeOutcome(input: HookInput, hook: ClaudeHook, code: number, stdout: string, stderr: string): ClaudeAnswer {
  const failed = (why: string): ClaudeAnswer => (hook.onFailure === 'block' ? { decision: 'block', reason: `the hook of plugin ${hook.plugin} failed (${why}), so cedia blocked this step`, failed: true } : { decision: 'allow' });
  const out = stdout.trim();
  let json: Record<string, unknown> | undefined;
  if (out.startsWith('{') && out.endsWith('}')) {
    try {
      const v = JSON.parse(out);
      if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Record<string, unknown>;
    } catch {
      return code === 2 ? blocked(input, stderr) : failed('its output is not valid JSON');
    }
  }
  if (code === 2) {
    // Claude Code's Stop: a missing file is the hook's own failure, not a refusal.
    if (input.event === 'stop' && !out && /No such file or directory/.test(stderr)) return failed(stderr.trim().split('\n')[0]!);
    const reason = json ? reasonOf(json) : undefined;
    return blocked(input, reason || stderr);
  }
  if (!json) return code === 0 ? { decision: 'allow' } : failed(`exit ${code}${stderr.trim() ? `: ${stderr.trim().split('\n')[0]!.slice(0, 200)}` : ''}`);
  if (code !== 0 && hook.onFailure === 'block') return failed(`exit ${code}`);
  const specific = (json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object' ? json.hookSpecificOutput : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  if (input.event === 'preToolUse') {
    const d = specific.permissionDecision ?? (json.decision === 'block' ? 'deny' : json.decision === 'approve' ? 'allow' : undefined);
    if (d === 'deny') return { decision: 'block', reason: text(specific.permissionDecisionReason) ?? text(json.reason) ?? `the hook of plugin ${hook.plugin} denied this call` };
    if (d === 'ask') return { decision: 'block', reason: `the hook of plugin ${hook.plugin} asks for the user's confirmation, which cedia cannot ask for here${text(specific.permissionDecisionReason) ? `: ${text(specific.permissionDecisionReason)}` : ''}` };
    if (json.continue === false) return { decision: 'block', reason: text(json.stopReason) ?? `the hook of plugin ${hook.plugin} stopped this call` };
    const updated = specific.updatedInput && typeof specific.updatedInput === 'object' && !Array.isArray(specific.updatedInput) ? cediaToolInput(input.tool, specific.updatedInput as JsonObject, input.input) : undefined;
    return { decision: 'allow', ...(updated ? { updatedInput: updated } : {}) };
  }
  if (input.event === 'postToolUse') {
    // Claude Code shows a post hook's block to the model beside the result, which has run: a note here.
    const note = [json.decision === 'block' ? text(json.reason) : undefined, text(specific.additionalContext)].filter(Boolean).join('\n');
    return { decision: 'allow', ...(note ? { note } : {}) };
  }
  if (json.decision === 'block') return { decision: 'block', reason: text(json.reason) ?? `the hook of plugin ${hook.plugin} refused the claim` };
  return { decision: 'allow' };
}

const reasonOf = (json: Record<string, unknown>) => {
  const s = json.hookSpecificOutput as Record<string, unknown> | undefined;
  const r = s?.permissionDecisionReason ?? json.reason;
  return typeof r === 'string' ? r : undefined;
};

// Exit 2: a pre hook blocks the call and a stop hook refuses the claim; a post hook's stderr is shown beside the
// result, which has run.
function blocked(input: HookInput, reason: string): ClaudeAnswer {
  const r = reason.trim();
  if (input.event === 'postToolUse') return { decision: 'allow', ...(r ? { note: r } : {}) };
  return { decision: 'block', reason: r || 'a plugin hook blocked this step' };
}

export const claudeEnv = (hook: ClaudeHook, cwd: string): Record<string, string> => ({ CLAUDE_PLUGIN_ROOT: hook.root, CLAUDE_PLUGIN_DATA: hook.data, CLAUDE_PROJECT_DIR: cwd });

// Exec form: ${CLAUDE_*} filled in each argument as plain text, as Claude Code does.
export const claudeArgv = (argv: string[], hook: ClaudeHook, cwd: string): string[] => {
  if (hook.form === 'shell') return argv;
  const env: Record<string, string> = claudeEnv(hook, cwd);
  return argv.map((a) => a.replace(/\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR)\}/g, (m, k: string) => env[k] ?? m));
};
