import { copySession, type Run } from './rewind.ts';
import type { ThreadStore } from './threads.ts';

// Edit and resend: a new thread whose conversation is another's as it stood just before one of its runs, so the
// person's message that started that run can be sent again, changed, without losing the original. Nothing else
// moves: the original thread is left as it is, and no file is touched (the fork runs in the same working tree;
// /rewind is the one that puts files back).
//
//   the new thread  an `open` event with the original's task and profile and `forkOf` naming the thread and run;
//                   then, when the run had a session to go on from, a `session` event (why `fork`) for a copy of
//                   that session's first events, byte for byte, so its cached prefix is the same bytes; then
//                   `stopped`, since nothing runs until the person sends the edited message to it.
//   at run 1        there is no conversation yet, so the fork has no session and its next run starts a new one.

export type Forked = { thread: string; run: Run; sessionId?: string };

// `at` is a run's number (from 1, as `threads show` lists them) or its id.
export function forkThread(store: ThreadStore, thread: string, at: string, deps: { sessionFile: (cwd: string, id: string) => string }): Forked | { error: string } {
  const t = store.read(thread);
  const run = /^\d+$/.test(at) ? t.runs[Number(at) - 1] : t.runs.find((r) => r.id === at);
  if (!run) return { error: t.runs.length ? `thread ${thread} has runs 1 to ${t.runs.length}, not ${at}` : `thread ${thread} has no run to fork at` };
  // The copy first: a session that cannot be copied leaves no half-made thread.
  const sessionId = run.from ? crypto.randomUUID() : undefined;
  const path = sessionId && deps.sessionFile(run.cwd, sessionId);
  if (run.from && path) copySession(run.from, path);
  const id = store.open(t.task, { title: t.title, forkOf: { thread, run: run.id }, ...(t.profile ? { profile: t.profile } : {}) });
  if (run.from && sessionId && path) store.append(id, { kind: 'session', sessionId, model: run.from.model, role: 'code', why: 'fork', path });
  store.append(id, { kind: 'state', state: 'stopped' });
  return { thread: id, run, ...(sessionId ? { sessionId } : {}) };
}
