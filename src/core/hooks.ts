import type { JsonObject } from './types.ts';
import { scrubbedEnv } from './tools/bash.ts';
import { inert } from './trust/frame.ts';

// Hooks are the user's own commands, run at three points of a session: before a call runs (it may block the
// call or rewrite its input, which the policy then decides again), after a call (it may add a note to the
// result), and when the model claims it is done (it may refuse the claim, like a failed check). They come from
// ~/.cedia/settings.json only: a repo must not run code outside the sandbox.
//
// A hook is an argv, run without a shell, outside the sandbox, with the scrubbed environment. It reads one JSON
// object on stdin and answers by exit code: 0 lets the step go on (stdout may hold a JSON answer), 2 blocks it
// with stderr as the reason. Anything else fails closed: a hook that cannot start, exits otherwise or times out
// blocks the call or refuses the claim, so a broken guard never lets a step through.

export const HOOK_EVENTS = ['preToolUse', 'postToolUse', 'stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
// `match`: an allow-rule pattern (`bash(git commit*)`, `edit(src/*)`, or a tool name); absent matches every call.
// Stop hooks have no match.
export type HookSpec = { command: string[]; match?: string; timeoutMs?: number };
export type Hooks = Partial<Record<HookEvent, HookSpec[]>>;

// What a hook is handed on stdin.
export type HookInput =
  | { event: 'preToolUse'; sessionId: string; cwd: string; tool: string; callId: string; input: JsonObject }
  | { event: 'postToolUse'; sessionId: string; cwd: string; tool: string; callId: string; input: JsonObject; output: { text: string; isError: boolean; exitCode?: number } }
  | { event: 'stop'; sessionId: string; cwd: string; result: string; changed: string[] };

// What cedia makes of the answer. `note` (post) and `reason` (block) are model-visible, so they are made inert and
// capped before they reach a result or a reminder.
export type HookOutcome =
  | { decision: 'allow'; updatedInput?: JsonObject; note?: string }
  | { decision: 'block'; reason: string; failed?: boolean };

export const HOOK_TIMEOUT_MS = 30_000;
const MAX_HOOK_TEXT = 4_000;
const MAX_HOOK_OUTPUT = 1_000_000;

export const hookName = (event: HookEvent, i: number, spec: HookSpec) => `${event}[${i}] ${spec.command[0] ?? ''}`.trim();

const capped = (text: string) => {
  const t = inert(text.trim());
  return t.length > MAX_HOOK_TEXT ? `${t.slice(0, MAX_HOOK_TEXT)} [... ${t.length - MAX_HOOK_TEXT} characters cut]` : t;
};

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    if (text.length < MAX_HOOK_OUTPUT) text += decoder.decode(r.value, { stream: true });
  }
  return text.slice(0, MAX_HOOK_OUTPUT);
}

export async function runHook(spec: HookSpec, input: HookInput, cwd: string): Promise<HookOutcome> {
  const failed = (why: string): HookOutcome => ({ decision: 'block', reason: `the hook ${spec.command[0] ?? '(empty)'} failed (${why}), so cedia blocked this step`, failed: true });
  if (!spec.command.length) return failed('it has no command');
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // The input goes as a whole buffer: a hook that answers without reading it (a fixed verdict) is not a failure.
    proc = Bun.spawn(spec.command, { cwd, env: scrubbedEnv(), stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe', detached: true });
  } catch (e) {
    return failed(`it could not start: ${(e as Error).message}`);
  }
  const timeout = spec.timeoutMs ?? HOOK_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      proc.kill('SIGKILL');
    }
  }, timeout);
  const out = readCapped(proc.stdout as ReadableStream<Uint8Array>);
  const err = readCapped(proc.stderr as ReadableStream<Uint8Array>);
  const code = await proc.exited;
  clearTimeout(timer);
  // A job the hook left running would hold its pipes open; a hook answers and is gone.
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // the group is already gone
  }
  const [stdout, stderr] = await Promise.all([out, err]);
  if (timedOut) return failed(`it ran past ${timeout} ms`);
  if (code === 2) return { decision: 'block', reason: capped(stderr) || `the hook ${spec.command[0]} blocked this step` };
  if (code !== 0) return failed(`exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}`);
  let answer: unknown;
  try {
    answer = stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch {
    answer = undefined; // plain text on stdout is the hook's own log, not an answer
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { decision: 'allow' };
  const a = answer as { decision?: unknown; reason?: unknown; updatedInput?: unknown; note?: unknown };
  if (a.decision === 'block') return { decision: 'block', reason: capped(typeof a.reason === 'string' ? a.reason : '') || `the hook ${spec.command[0]} blocked this step` };
  const updated = a.updatedInput && typeof a.updatedInput === 'object' && !Array.isArray(a.updatedInput) ? (a.updatedInput as JsonObject) : undefined;
  const note = typeof a.note === 'string' && a.note.trim() ? capped(a.note) : undefined;
  return { decision: 'allow', ...(updated ? { updatedInput: updated } : {}), ...(note ? { note } : {}) };
}

// Checks the hooks setting's shape, so a typo fails at start instead of leaving a guard silently off.
export function checkHooks(value: unknown): Hooks {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('"hooks" must be an object');
  for (const [event, list] of Object.entries(value)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) throw new Error(`unknown hook event "${event}" (known: ${HOOK_EVENTS.join(', ')})`);
    if (!Array.isArray(list)) throw new Error(`"hooks.${event}" must be a list`);
    for (const h of list) {
      if (typeof h !== 'object' || h === null) throw new Error(`each of "hooks.${event}" must be an object`);
      const unknown = Object.keys(h).find((k) => !['command', 'match', 'timeoutMs'].includes(k));
      if (unknown) throw new Error(`unknown key "${unknown}" in "hooks.${event}" (known: command, match, timeoutMs)`);
      const spec = h as Record<string, unknown>;
      if (!Array.isArray(spec.command) || !spec.command.length || !spec.command.every((c) => typeof c === 'string'))
        throw new Error(`"hooks.${event}[].command" must be a non-empty list of strings (an argv, run without a shell)`);
      if (spec.match !== undefined && (typeof spec.match !== 'string' || event === 'stop')) throw new Error(`"hooks.${event}[].match" must be a rule string, and stop hooks take none`);
      if (spec.timeoutMs !== undefined && (typeof spec.timeoutMs !== 'number' || spec.timeoutMs <= 0)) throw new Error(`"hooks.${event}[].timeoutMs" must be a positive number`);
    }
  }
  return value as Hooks;
}
