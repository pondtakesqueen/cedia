import { costUsd } from '../providers/catalog.ts';
import type { EventOf, ModelSpec, SessionEvent, Usage } from '../types.ts';
import { inert } from '../trust/frame.ts';

// Handoff instead of compaction: when a session's context grows long, it writes a note for its successor while
// its whole prefix is still cached, and a new session of the same thread starts from the task and that note. No
// message of the old session is edited (thinking signatures and the cache stay valid), and its full log stays
// searchable through the recall tool, so nothing is lost; the new session just stops paying to re-read it.

// Past this many tokens a turn costs more than a handoff saves. Half the window, capped: a 1M window would
// otherwise re-read up to 500k cached tokens every turn. A model with a long-context price hands off before the
// whole request moves to it, with room for one more turn.
export const HANDOFF_CAP = 150_000;
// Where cache reads cost a twentieth of input (Opus 5.5, Sonnet 5.5), each turn's re-read outweighs a handoff
// sooner: replaying the 65 sessions on file that passed 60k at those prices put the cheapest point at 80k to 90k,
// with 115k 0.8% above it and 150k 2.1%. 115k keeps more of the task in one session for about the same cost.
// Fable (a fortieth) stays at the cap, and the replay found it flat there.
export const HANDOFF_CAP_TWENTIETH = 115_000;
export function defaultHandoffAt(model: ModelSpec): number {
  const above = model.price.above?.tokens;
  const ratio = model.price.input ? model.price.cacheRead / model.price.input : 0;
  const cap = ratio > 0.025 && ratio <= 0.05 ? HANDOFF_CAP_TWENTIETH : HANDOFF_CAP;
  return Math.min(Math.floor(model.caps.contextWindow / 2), cap, above ? Math.floor(above * 0.9) : Infinity);
}

// Handoffs in one run, at most; past it the session goes on in its own context until it ends.
export const MAX_HANDOFFS = 8;

// The context the next request starts from: everything just sent plus the reply.
export const contextSize = (u: Usage) => u.uncached + u.cacheRead + u.cacheWrite + u.output;

// What every session of a thread sends before its first message, a handoff or not: the system prompt and the tool
// definitions, at chars/4. That undercounts JSON schemas (a real 110k characters of definitions were about 41k
// tokens), so a session is held to at least true doubling of the rest.
export const fixedTokens = (header: { system: string; tools: unknown[] }) => Math.ceil((header.system.length + JSON.stringify(header.tools).length) / 4);

export const HANDOFF_PROMPT = `Your context is long, so cedia will continue this task in a fresh session. It starts with the original task and the note you write now, and nothing else of this session. Do not call tools: reply with the note only.

Write it for a capable engineer who has not seen this session:
- What done looks like, and anything the user asked for that the task text leaves out.
- What you changed, file by file, and what you checked and how (command and result).
- Decisions you made and why, and approaches you ruled out, so they are not retried.
- The plan for what is left, in order, starting with the next step: for each step the file and the functions, types and signatures to add or change, concrete enough to carry out without designing it again.
- The files and line ranges the next step needs, so it reads those instead of the whole codebase.
- Facts that are costly to find again: exact error messages, paths, line numbers, commands that work.
- The tools you called that worked (names and what each gave you), so the next session reuses them instead of rediscovering how.

Be specific and brief. The next session can search this session's full log with the recall tool, so point to what is there instead of copying long output.`;

// Retried once if the model calls a tool instead of writing the note.
export const HANDOFF_NO_TOOLS = 'not run: cedia is handing this task to a new session. Write the handoff note now, without calling tools.';

export const handoffNote = (sessionId: string, note: string) =>
  `This task continues from an earlier session of this thread (${sessionId}), which handed off when its context grew long. Its note follows: it is your own earlier work, but check the working tree before relying on a detail. Its plan is settled: carry it out from the next step instead of planning the task again, and read only what that step needs (re-reading and re-planning are what make a handoff slow). The recall tool searches the earlier sessions' full logs for anything the note leaves out.

<handoff session="${sessionId}">
${inert(note)}
</handoff>`;

// Resuming a thread whose last session's cache has expired re-reads its whole context at the uncached price; a new
// session from the thread's note or result starts small and re-reads only what it needs. A session this small or
// smaller is always resumed, since losing its context costs more than re-reading it.
export const COLD_RESUME_MIN = 30_000;

export type ResumeChoice = { cold: boolean; stale: boolean; idleMs: number; contextTokens: number; resumeUsd: number; freshUsd: number; fresh: boolean };

// What re-sending `tokens` of prompt costs when none of it is cached: a cache write where the provider prices one,
// the input price where caching is automatic.
const coldUsd = (model: ModelSpec, tokens: number, at: Date) =>
  costUsd(model, model.price.cacheWrite > 0 ? { uncached: 0, cacheRead: 0, cacheWrite: tokens, output: 0 } : { uncached: tokens, cacheRead: 0, cacheWrite: 0, output: 0 }, at);

// Whether to resume a session or start a new one from the thread's note: new when the session's cache has expired,
// its context is past COLD_RESUME_MIN, and re-reading it costs more than twice what the new session's start does
// (the margin pays for what the new session reads again). Past 80% of the TTL the next request will likely land
// after expiry, so the resume is priced as a re-read and a big session goes fresh now instead of resuming into a
// certain cache miss. `freshTokens` is that start: system prompt, tools, preamble, note and task.
export function resumeChoice(events: SessionEvent[], model: ModelSpec, freshTokens: number, now = new Date()): ResumeChoice | undefined {
  const reply = events.findLast((e): e is EventOf<'assistant'> => e.kind === 'assistant');
  const request = events.findLast((e): e is EventOf<'request'> => e.kind === 'request');
  if (!reply || !request) return undefined;
  const ttlMs = request.ttl === '1h' ? 3_600_000 : 300_000;
  // From the request's start, not the reply's end: the TTL counts from when the prefixed request went out,
  // and a long-streaming reply eats into it.
  const idleMs = now.getTime() - Date.parse(request.at);
  const cold = idleMs > ttlMs;
  const stale = idleMs > ttlMs * 0.8;
  const contextTokens = contextSize(reply.usage);
  const resumeUsd = cold || stale ? coldUsd(model, contextTokens, now) : costUsd(model, { uncached: 0, cacheRead: contextTokens, cacheWrite: 0, output: 0 }, now);
  const freshUsd = coldUsd(model, freshTokens, now);
  return { cold, stale, idleMs, contextTokens, resumeUsd, freshUsd, fresh: (cold || stale) && contextTokens >= COLD_RESUME_MIN && resumeUsd > 2 * freshUsd };
}
