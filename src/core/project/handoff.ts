import type { ModelSpec, Usage } from '../types.ts';
import { inert } from '../trust/frame.ts';

// Handoff instead of compaction: when a session's context grows long, it writes a note for its successor while
// its whole prefix is still cached, and a new session of the same thread starts from the task and that note. No
// message of the old session is edited (thinking signatures and the cache stay valid), and its full log stays
// searchable through the recall tool, so nothing is lost; the new session just stops paying to re-read it.

// Past this many tokens a turn costs more than a handoff saves. Half the window, capped: a 1M window would
// otherwise re-read up to 500k cached tokens every turn. A model with a long-context price hands off before the
// whole request moves to it, with room for one more turn.
export const HANDOFF_CAP = 150_000;
export function defaultHandoffAt(model: ModelSpec): number {
  const above = model.price.above?.tokens;
  return Math.min(Math.floor(model.caps.contextWindow / 2), HANDOFF_CAP, above ? Math.floor(above * 0.9) : Infinity);
}

// Handoffs in one run, at most; past it the session goes on in its own context until it ends.
export const MAX_HANDOFFS = 8;

// The context the next request starts from: everything just sent plus the reply.
export const contextSize = (u: Usage) => u.uncached + u.cacheRead + u.cacheWrite + u.output;

export const HANDOFF_PROMPT = `Your context is long, so cedia will continue this task in a fresh session. It starts with the original task and the note you write now, and nothing else of this session. Do not call tools: reply with the note only.

Write it for a capable engineer who has not seen this session:
- What done looks like, and anything the user asked for that the task text leaves out.
- What you changed, file by file, and what you checked and how (command and result).
- Decisions you made and why, and approaches you ruled out, so they are not retried.
- The plan for what is left, in order, starting with the next step: for each step the file and the functions, types and signatures to add or change, concrete enough to carry out without designing it again.
- The files and line ranges the next step needs, so it reads those instead of the whole codebase.
- Facts that are costly to find again: exact error messages, paths, line numbers, commands that work.

Be specific and brief. The next session can search this session's full log with the recall tool, so point to what is there instead of copying long output.`;

// Retried once if the model calls a tool instead of writing the note.
export const HANDOFF_NO_TOOLS = 'not run: cedia is handing this task to a new session. Write the handoff note now, without calling tools.';

export const handoffNote = (sessionId: string, note: string) =>
  `This task continues from an earlier session of this thread (${sessionId}), which handed off when its context grew long. Its note follows: it is your own earlier work, but check the working tree before relying on a detail. Its plan is settled: carry it out from the next step instead of planning the task again, and read only what that step needs (re-reading and re-planning are what make a handoff slow). The recall tool searches the earlier sessions' full logs for anything the note leaves out.

<handoff session="${sessionId}">
${inert(note)}
</handoff>`;
