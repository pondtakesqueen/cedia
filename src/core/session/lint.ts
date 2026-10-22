import type { EventOf, SessionEvent } from '../types.ts';

// Checks the invariants SPEC.md "Trust" promises about every log. Pure: it reads events, never the model.
export type LintFinding = { at: number; rule: string; message: string };

const HASH = /^[0-9a-f]{16}$/;

export function lintSession(events: SessionEvent[]): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (at: number, rule: string, message: string) => out.push({ at, rule, message });
  if (events[0]?.kind !== 'session') add(0, 'session-first', 'the log must start with a session event');

  let systemHash: string | undefined;
  let toolsHash: string | undefined;
  const open = new Map<string, number>(); // tool_use callId -> index of its assistant event
  const results = new Set<string>();
  const allowed = new Set<string>();
  const denied = new Set<string>();
  const intents = new Set<string>();
  let pendingRequest: { at: number; event: EventOf<'request'>; attempts: number; ok: boolean } | undefined;

  events.forEach((e, i) => {
    if (i > 0 && e.parentId !== events[i - 1]!.id) add(i, 'parent-chain', `parentId does not point at the previous event`);
    switch (e.kind) {
      case 'session':
        if (i > 0) add(i, 'session-first', 'a second session event');
        break;
      case 'request':
        if (pendingRequest && !pendingRequest.ok) add(pendingRequest.at, 'request-attempt', 'request has no successful attempt and the turn did not end');
        systemHash ??= e.systemHash;
        toolsHash ??= e.toolsHash;
        if (e.systemHash !== systemHash) add(i, 'prefix-stable', 'systemHash changed mid-session');
        if (e.toolsHash !== toolsHash) add(i, 'prefix-stable', 'toolsHash changed mid-session');
        for (const [name, value] of Object.entries(e.headers))
          if (!HASH.test(value)) add(i, 'no-header-values', `header ${name} holds a value, not a hash`);
        pendingRequest = { at: i, event: e, attempts: 0, ok: false };
        break;
      case 'attempt':
        if (!pendingRequest || e.requestId !== events[pendingRequest.at]!.id) add(i, 'request-attempt', 'attempt does not belong to the open request');
        else {
          pendingRequest.attempts++;
          if (e.n !== pendingRequest.attempts) add(i, 'request-attempt', `attempt n=${e.n}, expected ${pendingRequest.attempts}`);
          if (!e.error) pendingRequest.ok = true;
        }
        break;
      case 'assistant':
        if (!pendingRequest || pendingRequest.attempts === 0) add(i, 'request-attempt', 'assistant event without a request and attempt before it');
        if (pendingRequest && !pendingRequest.ok && e.stop !== 'aborted') add(i, 'request-attempt', 'assistant event after failed attempts only');
        pendingRequest = undefined;
        for (const b of e.blocks) if (b.type === 'tool_use') open.set(b.callId ?? b.id, i);
        break;
      case 'hook':
        if (e.callId !== undefined && !open.has(e.callId)) add(i, 'tool-pairing', `hook for unknown call ${e.callId}`);
        break;
      case 'permission':
        if (!open.has(e.callId)) add(i, 'tool-pairing', `permission for unknown call ${e.callId}`);
        (e.decision === 'allow' ? allowed : denied).add(e.callId);
        break;
      case 'tool_intent':
        if (!open.has(e.callId)) add(i, 'tool-pairing', `intent for unknown call ${e.callId}`);
        if (!allowed.has(e.callId)) add(i, 'permission-order', `intent for ${e.callId} without an allow decision before it`);
        intents.add(e.callId);
        break;
      case 'tool_result':
        if (!open.has(e.callId)) add(i, 'tool-pairing', `result for unknown call ${e.callId}`);
        if (results.has(e.callId)) add(i, 'tool-pairing', `second result for ${e.callId}`);
        results.add(e.callId);
        if (denied.has(e.callId) && e.status !== 'denied') add(i, 'permission-order', `${e.callId} was denied but its result is ${e.status}`);
        if (e.status === 'denied' && !denied.has(e.callId)) add(i, 'permission-order', `${e.callId} is denied without a deny decision`);
        if ((e.status === 'completed' || e.status === 'failed') && !intents.has(e.callId)) add(i, 'permission-order', `${e.callId} ran without a tool_intent`);
        break;
      case 'turn_end':
        pendingRequest = undefined;
        break;
      case 'result':
        if (events[i - 1]?.kind !== 'turn_end' && events[i - 1]?.kind !== 'result') add(i, 'turn-end', 'a result that does not follow turn_end');
        break;
    }
    // Results for a turn's calls must all arrive before the next request.
    if (e.kind === 'request' || e.kind === 'turn_end') {
      for (const [id, at] of open) if (!results.has(id)) add(at, 'tool-pairing', `tool_use ${id} has no tool_result before ${e.kind}`);
      // Call ids only need to be unique within a turn.
      for (const set of [open, results, allowed, denied, intents]) set.clear();
    }
  });
  // A run's result may follow the last turn_end.
  const last = events.findLastIndex((e) => e.kind !== 'result');
  if (events.length > 1 && events[last]?.kind !== 'turn_end') add(last, 'turn-end', 'the log does not end with turn_end');
  return out;
}
