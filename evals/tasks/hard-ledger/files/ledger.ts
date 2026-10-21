import { resolve } from 'node:path';

// A slice of a coding agent's session log. Events are in order; `request` starts a new model call.
export type SessionEvent =
  | { kind: 'request' }
  | { kind: 'tool_intent'; callId: string; tool: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; callId: string; status: 'completed' | 'failed' | 'denied' | 'not_started'; output: { isError: boolean; exitCode?: number } }
  | { kind: 'snapshot'; callId?: string; changed: string[] }
  | { kind: 'text'; text: string };

// `at` is the index of the tool_result event in the log.
export type LedgerEntry =
  | { kind: 'write'; at: number; tool: string; path?: string; command?: string }
  | { kind: 'check'; at: number; command: string; exitCode: number };

export type Evidence = { changed: string[]; checks: { command: string; exitCode: number }[]; unverified: string[] };

// Commands that only read. Given; do not change.
export function isReadOnly(command: string): boolean {
  return /^(ls|cat|head|tail|grep|rg|find|wc|pwd|echo|git (status|diff|log|show))(\s|$)/.test(command.trim()) && !/[>|;&]/.test(command);
}

// Returns the declared check (as written in `checks`) that a bash command runs, or undefined.
// The whole command must be the check, after trimming and collapsing whitespace on both, and dropping a trailing
// ` 2>&1` from both. A pipe or a chain would hide the check's exit code, so `bun test | tail` does not count.
// One exception: a leading `cd <dir> && ` is removed when <dir> (quotes stripped) resolves to `cwd`.
export function matchCheck(command: string, checks: string[], cwd?: string): string | undefined {
  throw new Error('not implemented');
}

// Walks the log and returns one entry per thing that happened, in log order.
// - Only tool_results whose call has a tool_intent since the last `request` count; denied and not_started
//   results never count.
// - A bash call (input.command) whose command matches a check is a check entry: exitCode from the output,
//   or 1 when it has none and isError is set, else 0. A check never counts as a write.
// - Otherwise, when a snapshot event anywhere in the log names this callId, one write entry per changed path
//   (none when the list is empty).
// - Otherwise an edit or write call that completed is a write entry with path = input.path.
// - Otherwise a bash call whose command is not read-only is a write entry with command set (no path).
export function ledgerEntries(events: SessionEvent[], checks: string[], cwd?: string): LedgerEntry[] {
  throw new Error('not implemented');
}

// changed: every write's label (path, or `bash: <command>`), first seen first, no duplicates.
// checks: every check entry, in order, as { command, exitCode }.
// unverified: labels of writes after the last passing check (all of them when no check passed), deduped.
export function evidence(entries: LedgerEntry[]): Evidence {
  throw new Error('not implemented');
}

// The done gate. With no declared checks, or no writes, it is satisfied. Otherwise a check with exit code 0
// must come after the last write.
export function verified(entries: LedgerEntry[], checks: string[]): boolean {
  throw new Error('not implemented');
}
