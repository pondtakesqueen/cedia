import { resolve } from 'node:path';
import { checkReadOnly } from '../tools/bash.ts';
import type { EventOf, Evidence, SessionEvent } from '../types.ts';

// The evidence ledger is derived from the log alone, so it says what happened, not what the model claims.
export type LedgerEntry =
  | { kind: 'write'; at: number; tool: string; path?: string; command?: string }
  | { kind: 'check'; at: number; command: string; exitCode: number };

// A bash call counts as a declared check only when its whole command is the check, give or take
// whitespace and a trailing 2>&1. A pipe would hide the check's exit code, so `bun test | tail` does not count.
// A leading `cd <working dir> &&` is allowed too: models often add it, and it changes nothing.
export function matchCheck(command: string, checks: string[], cwd?: string): string | undefined {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/ 2>&1$/, '');
  let c = norm(command);
  const cd = /^cd ("[^"]*"|'[^']*'|\S+) ?&& ?(.*)$/.exec(c);
  if (cd && cwd && resolve(cwd, cd[1]!.replace(/^["']|["']$/g, '')) === resolve(cwd)) c = cd[2]!;
  return checks.find((k) => norm(k) === c);
}

export function ledgerEntries(events: SessionEvent[], checks: string[], cwd?: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const intents = new Map<string, EventOf<'tool_intent'>>();
  // With snapshots the log names the files each writing call changed, bash included.
  const snapped = new Map<string, string[]>();
  for (const e of events) if (e.kind === 'snapshot' && e.callId) snapped.set(e.callId, e.changed);
  events.forEach((e, at) => {
    if (e.kind === 'request') intents.clear();
    if (e.kind === 'tool_intent') intents.set(e.callId, e);
    if (e.kind !== 'tool_result') return;
    const intent = intents.get(e.callId);
    if (!intent || e.status === 'denied' || e.status === 'not_started') return;
    const files = snapped.get(e.callId);
    const command = intent.tool === 'bash' ? String(intent.input.command ?? '') : undefined;
    const check = command !== undefined ? matchCheck(command, checks, cwd) : undefined;
    if (check !== undefined) {
      // Files a check leaves behind (caches, coverage) are not the change it verifies.
      out.push({ kind: 'check', at, command: check, exitCode: e.output.exitCode ?? (e.output.isError ? 1 : 0) });
    } else if (files) {
      for (const path of files) out.push({ kind: 'write', at, tool: intent.tool, path });
    } else if (intent.tool === 'edit' || intent.tool === 'write') {
      if (e.status === 'completed') out.push({ kind: 'write', at, tool: intent.tool, path: String(intent.input.path) });
    } else if (intent.tool === 'spawn' && intent.input.kind === 'work') {
      // Without snapshots, a sub-thread that may write counts as one write the gate must see checked.
      out.push({ kind: 'write', at, tool: 'spawn', command: 'a work sub-thread' });
    } else if (command !== undefined && !checkReadOnly(command).ok) {
      out.push({ kind: 'write', at, tool: 'bash', command });
    }
  });
  return out;
}

const label = (w: Extract<LedgerEntry, { kind: 'write' }>) => w.path ?? `${w.tool}: ${w.command}`;

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
