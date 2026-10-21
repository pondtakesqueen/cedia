import { checkReadOnly } from '../tools/bash.ts';
import type { EventOf, Evidence, SessionEvent } from '../types.ts';

// The evidence ledger is derived from the log alone, so it says what happened, not what the model claims.
export type LedgerEntry =
  | { kind: 'write'; at: number; tool: string; path?: string; command?: string }
  | { kind: 'check'; at: number; command: string; exitCode: number };

// A bash call counts as a declared check only when its whole command is the check, give or take
// whitespace and a trailing 2>&1. A pipe would hide the check's exit code, so `bun test | tail` does not count.
export function matchCheck(command: string, checks: string[]): string | undefined {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/ 2>&1$/, '');
  const c = norm(command);
  return checks.find((k) => norm(k) === c);
}

export function ledgerEntries(events: SessionEvent[], checks: string[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const intents = new Map<string, EventOf<'tool_intent'>>();
  events.forEach((e, at) => {
    if (e.kind === 'request') intents.clear();
    if (e.kind === 'tool_intent') intents.set(e.callId, e);
    if (e.kind !== 'tool_result') return;
    const intent = intents.get(e.callId);
    if (!intent || e.status === 'denied' || e.status === 'not_started') return;
    if (intent.tool === 'edit' || intent.tool === 'write') {
      if (e.status === 'completed') out.push({ kind: 'write', at, tool: intent.tool, path: String(intent.input.path) });
    } else if (intent.tool === 'bash') {
      const command = String(intent.input.command ?? '');
      const check = matchCheck(command, checks);
      if (check !== undefined) out.push({ kind: 'check', at, command: check, exitCode: e.output.exitCode ?? (e.output.isError ? 1 : 0) });
      else if (!checkReadOnly(command).ok) out.push({ kind: 'write', at, tool: 'bash', command });
    }
  });
  return out;
}

const label = (w: Extract<LedgerEntry, { kind: 'write' }>) => w.path ?? `bash: ${w.command}`;

export function evidence(entries: LedgerEntry[]): Evidence {
  const writes = entries.filter((e): e is Extract<LedgerEntry, { kind: 'write' }> => e.kind === 'write');
  const checks = entries.filter((e): e is Extract<LedgerEntry, { kind: 'check' }> => e.kind === 'check');
  const lastPass = Math.max(-1, ...checks.filter((c) => c.exitCode === 0).map((c) => c.at));
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    changed: uniq(writes.map(label)),
    checks: checks.map(({ command, exitCode }) => ({ command, exitCode })),
    unverified: uniq(writes.filter((w) => w.at > lastPass).map(label)),
  };
}

// Done gate: with declared checks, a run that wrote must have a passing check after its last write.
export function verified(entries: LedgerEntry[], checks: string[]): boolean {
  if (!checks.length) return true;
  const lastWrite = Math.max(-1, ...entries.filter((e) => e.kind === 'write').map((e) => e.at));
  if (lastWrite < 0) return true;
  return entries.some((e) => e.kind === 'check' && e.exitCode === 0 && e.at > lastWrite);
}
