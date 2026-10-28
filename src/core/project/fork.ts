import { SessionLog, sessionExists } from '../session/log.ts';
import type { ImageRef, SessionEvent } from '../types.ts';
import { copySession, type Run } from './rewind.ts';
import type { RunFrom, ThreadStore } from './threads.ts';

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
//
// Side chat: `at` is `end`, the thread as it stands now, even while it works. The copy ends at the last settled
// point of its latest writer session (no tool call waiting on its result), `forkOf` names no run, and `side`
// marks the new thread as a side chat, which a client shows beside the original and deletes when it closes.

export type Forked = { thread: string; run?: Run; sessionId?: string };

// What `threads fork <id> <n|run|end> --json` prints. `images`: the forked run's, which the client sends again with
// the edited message as `-p --image sha256:<hex>` unless the person took them off.
export type ForkResult = { thread: string; run?: string; sessionId?: string; images?: ImageRef[] };

// How many of a session's events make a conversation the model can go on from: up to the last one after which
// no tool call waits on its result and the model is not mid-request.
export function settledEvents(events: SessionEvent[]): number {
  const open = new Set<string>();
  let settled = 0;
  events.forEach((e, i) => {
    if (e.kind === 'assistant') for (const b of e.blocks) if (b.type === 'tool_use') open.add(b.callId ?? b.id);
    if (e.kind === 'tool_result') open.delete(e.callId);
    if (open.size === 0 && (e.kind === 'assistant' || e.kind === 'tool_result' || e.kind === 'turn_end' || e.kind === 'result' || e.kind === 'session')) settled = i + 1;
  });
  return settled;
}

// The thread's latest writer session as it stands now, cut at its last settled point; none before any run.
// `cwd` is where the session ran, which names where its copy goes.
function endOf(store: ThreadStore, thread: string): { from: RunFrom; cwd: string } | undefined {
  const last = store.read(thread).sessions.findLast((s) => s.role === 'code' && !s.rewound);
  if (!last?.path || !sessionExists(last.path)) return undefined;
  const log = SessionLog.load(last.path).events;
  const head = log[0];
  const events = settledEvents(log);
  if (head?.kind !== 'session' || events < 2) return undefined;
  return { from: { sessionId: last.sessionId, path: last.path, events, model: last.model }, cwd: head.cwd };
}

// `at` is a run's number (from 1, as `threads show` lists them), its id, or `end`.
export function forkThread(store: ThreadStore, thread: string, at: string, deps: { sessionFile: (cwd: string, id: string) => string }, opts: { side?: boolean } = {}): Forked | { error: string } {
  const t = store.read(thread);
  let run: Run | undefined;
  let from: RunFrom | undefined;
  let cwd: string | undefined;
  if (at === 'end') {
    const end = endOf(store, thread);
    if (!end) return { error: `thread ${thread} has no conversation yet to fork` };
    ({ from, cwd } = end);
  } else {
    run = /^\d+$/.test(at) ? t.runs[Number(at) - 1] : t.runs.find((r) => r.id === at);
    if (!run) return { error: t.runs.length ? `thread ${thread} has runs 1 to ${t.runs.length}, not ${at}` : `thread ${thread} has no run to fork at` };
    from = run.from;
    cwd = run.cwd;
  }
  // The copy first: a session that cannot be copied leaves no half-made thread.
  const sessionId = from && cwd ? crypto.randomUUID() : undefined;
  const path = sessionId && cwd && deps.sessionFile(cwd, sessionId);
  if (from && path) copySession(from, path);
  const title = opts.side ? `side chat: ${t.title}` : t.title;
  const id = store.open(t.task, { title, forkOf: { thread, ...(run ? { run: run.id } : {}) }, ...(opts.side ? { side: true } : {}), ...(t.profile ? { profile: t.profile } : {}) });
  if (from && sessionId && path) store.append(id, { kind: 'session', sessionId, model: from.model, role: 'code', why: 'fork', path });
  store.append(id, { kind: 'state', state: 'stopped' });
  return { thread: id, ...(run ? { run } : {}), ...(sessionId ? { sessionId } : {}) };
}
