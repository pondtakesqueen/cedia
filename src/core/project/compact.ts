import type { CompactionBlock, EventId, EventOf, NewEvent, SessionEvent } from '../types.ts';
import type { SessionLog } from '../session/log.ts';
import { sessionHeader } from '../context/build.ts';

// Handoff by compaction, on a model that takes on-demand compaction requests (Anthropic beta compact-2026-09-04).
// The note handoff (handoff.ts) asks the model for a note and starts the next session from the task and the note,
// so the next session reads again whatever it needs. Here the provider writes a signed summary of the session up
// to an earlier request, in the background while the session goes on, and the next session starts from that
// summary followed by every turn after that request, word for word, thinking included. Nothing is edited: the old
// session's log stays as it was, and the new one holds the summary and copies of the kept turns as its own events.
// The kept turns' thinking stays valid because the summary is the provider's, written on the same model under the
// same system prompt and tools, and the kept turns directly follow the messages it summarized.

// When to start and how much to keep, as fractions of the handoff point. The compaction starts early enough that
// the summary usually arrives before the context reaches the handoff point (where the session waits for it), and
// the newest quarter of the context is kept word for word.
export const COMPACT_START = 0.85;
export const COMPACT_KEEP = 0.25;
export const compactPlan = (handoffAt: number) => ({ startAt: Math.floor(handoffAt * COMPACT_START), keepTokens: Math.floor(handoffAt * COMPACT_KEEP) });

// Replaces the provider's own summarization prompt, which it would otherwise use whole. The same points as the
// handoff note, for the same reader: the session that goes on from here.
export const COMPACT_INSTRUCTIONS = `Summarize this coding session so that you can carry on with the task from the summary alone. The newest turns follow the summary word for word, so they need no summary. Do not call tools: reply with the summary text only.

Cover, specifically and briefly:
- The task, what done looks like, and anything the user asked for that the task text leaves out.
- What was changed, file by file, and what was checked and how (command and result).
- Decisions made and why, and approaches ruled out, so they are not retried.
- The plan for what is left, in order, with the files, functions, types and signatures each step touches.
- The files and line ranges the next steps need, so they are read instead of the whole codebase.
- Facts that are costly to find again: exact error messages, paths, line numbers, commands that work.
- The tools called that the next steps still need (names), so they are reused, not rediscovered.`;

// The request to summarize up to: the latest of the run's requests (from `from` on) whose reply saw at most
// size - keepTokens of input, so at least keepTokens of the newest context is kept. Its reply must hold text or a
// tool call, so the kept turns start with an assistant message (one with the role of the last summarized message
// would be merged into it). Undefined when no request qualifies.
export function compactionCut(events: SessionEvent[], from: number, size: number, keepTokens: number): number | undefined {
  let cut: number | undefined;
  let open: number | undefined;
  for (let i = from; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === 'request') open = i;
    if (e.kind !== 'assistant' || open === undefined) continue;
    const input = e.usage.uncached + e.usage.cacheRead + e.usage.cacheWrite;
    const said = e.stop !== 'aborted' && e.blocks.some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim() !== ''));
    if (said && input <= size - keepTokens) cut = open;
    open = undefined;
  }
  return cut;
}

// Not part of what a new session copies: the old session's header and end, its own compaction, and refreshes of
// its cache, which reach no model.
const NOT_KEPT = new Set<SessionEvent['kind']>(['session', 'turn_end', 'compact_request', 'compaction', 'keepalive', 'summary']);

// Opens the session that goes on from `from`'s summary: a header like `from`'s (the same system prompt and tools,
// which the kept turns' thinking depends on), the summary, then copies of `from`'s events from the summarized
// request on. Copies get new ids, and the ids they refer to are mapped to the copies.
export function seedCompacted(from: { id: string; events: SessionEvent[] }, to: SessionLog, c: { block: CompactionBlock; of: EventId }): void {
  if (to.events.length) throw new Error('a compacted session starts empty');
  const header = sessionHeader(from.events);
  const at = from.events.findIndex((e) => e.id === c.of);
  if (at < 0) throw new Error(`no request ${c.of} in session ${from.id}`);
  const kept = from.events.slice(at).filter((e) => !NOT_KEPT.has(e.kind));
  const { id: _id, parentId: _p, at: _at, ...body } = header;
  to.append({ ...body, parentSession: from.id });
  to.append({ kind: 'summary', session: from.id, block: c.block, kept: kept.length });
  const ids = new Map<string, EventId>();
  for (const e of kept) {
    const { id, parentId: _parent, ...rest } = e;
    const copy = { ...rest } as NewEvent & { at?: string; requestId?: EventId };
    if (copy.requestId) copy.requestId = ids.get(copy.requestId) ?? copy.requestId;
    ids.set(id, to.append(copy).id);
  }
}

export const compactedNote = (sessionId: string) =>
  `This task continues from an earlier session of this thread (${sessionId}), whose context grew long. The provider summarized its older part, and the summary and the newest turns of that session come before this message: they are your own earlier work. Go on from the last of those turns instead of planning the task again, and check the working tree before relying on a detail. The task follows again, as the user gave it.`;

// The session's first reply of its own: in a session that starts from a summary, the first after the copied turns.
export function firstReply(events: SessionEvent[], runStart: number): EventOf<'assistant'> | undefined {
  const own = events.some((e) => e.kind === 'summary') ? events.slice(runStart) : events;
  return own.find((e): e is EventOf<'assistant'> => e.kind === 'assistant');
}
