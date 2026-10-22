import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Snapshots } from '../safety/snapshot.ts';
import { sessionExists } from '../session/log.ts';
import type { Thread, ThreadEvent, ThreadStore } from './threads.ts';

// `/rewind`: the thread goes back to just before one of its runs, conversation and files together. Each run
// records where it started (a `run` event: the working tree's snapshot, and the writer session with how many
// events it had), so going back is:
//
//   files         every file a run since then changed (the `turn` events, in each working directory they were in)
//                 is put back to the tree the run started from. When one changed again after the last run that
//                 wrote it (the user's own edit), nothing is rewound unless forced: a rewind that left files behind
//                 could not be redone, since the runs that knew them are gone from the thread.
//   conversation  a new session whose log is a copy of that session's first events, byte for byte, so the prefix
//                 is the same bytes (a provider that keys its cache by session id reads it once more); the thread
//                 goes on in it. A rewind to the first run leaves no session: the next run starts a new one.
//   the thread    a `rewind` event: its fold drops what happened from the run on (sessions, turns, results,
//                 deliveries, and whatever a dropped run writes later), keeping the messages, so one delivered
//                 only to a dropped session waits again. A thread whose last run has not ended is not rewound unless forced.
//
// The model is told at its next turn, through the thread's inbox, since commands those runs ran and anything outside
// the working tree are as they were. The dropped sessions' logs stay on disk, and recall no longer searches them.

export type Run = Thread['runs'][number];
export type Rewound = { run: Run; restored: string[]; sessionId?: string };

// The turns since `run` began, in one working directory (a thread may run in several worktrees of a project).
const since = (t: Thread, run: Run) => t.turns.filter((x) => x.runs > t.runs.indexOf(run));

// What going back means in one working directory: the files to put back to `target`, and the ones changed since
// the run that last wrote them (the user's own edit), which go back only when forced.
type Plan = { cwd: string; snapshots: Snapshots; target: string; todo: string[]; moved: string[] };

function plan(t: Thread, run: Run, cwd: string, snapshots: Snapshots): Plan | undefined {
  const turns = since(t, run).filter((x) => x.cwd === cwd);
  // The tree the files go back to: the run's own when it ran here, else the one the first later run here started
  // from, else the first change's.
  const later = t.runs.slice(t.runs.indexOf(run)).find((r) => r.cwd === cwd && r.tree);
  const target = (run.cwd === cwd ? run.tree : undefined) ?? later?.tree ?? turns[0]?.before;
  if (!target || !turns.length) return undefined;
  // Each file, and the tree it was in after the last turn that changed it.
  const last = new Map<string, string>();
  for (const turn of turns) for (const f of snapshots.diff(turn.before, turn.after)) last.set(f, turn.after);
  const now = snapshots.take();
  if (!now) throw new Error(`cannot snapshot ${cwd}`);
  const away = new Set(snapshots.diff(target, now));
  const todo = [...last.keys()].filter((f) => away.has(f)).sort();
  const moved = new Set<string>();
  for (const tree of new Set(last.values())) for (const f of snapshots.diff(tree, now)) if (last.get(f) === tree) moved.add(f);
  return { cwd, snapshots, target, todo, moved: todo.filter((f) => moved.has(f)) };
}

// A copy of a session's first `events` events, as a new session file.
function copySession(from: NonNullable<Run['from']>, to: string): void {
  if (!sessionExists(from.path)) throw new Error(`the session the run started in is gone: ${from.path}`);
  const lines = readFileSync(from.path, 'utf8').split('\n').filter(Boolean);
  if (lines.length < from.events) throw new Error(`session ${from.sessionId} has fewer events than when the run started`);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, lines.slice(0, from.events).map((l) => `${l}\n`).join(''));
}

// Rewinds `thread` to just before its run number `n` (from 1, as `threads show` lists them). `open` gives the
// snapshots of a working directory; `sessionFile` the path for a new session's log. It refuses, changing nothing,
// while the thread is working (a run may still be writing to it) and when a file to put back changed since the
// run that wrote it; `force` goes ahead in both cases.
export function rewindThread(
  store: ThreadStore,
  thread: string,
  n: number,
  deps: { open: (cwd: string) => Snapshots | undefined; sessionFile: (cwd: string, id: string) => string },
  opts: { force?: boolean } = {},
): Rewound | { error: string } {
  const t = store.read(thread);
  const run = Number.isInteger(n) ? t.runs[n - 1] : undefined;
  if (!run) return { error: t.runs.length ? `thread ${thread} has runs 1 to ${t.runs.length}, not ${n}` : `thread ${thread} has no run to rewind to` };
  if (t.running && !opts.force) return { error: `thread ${thread} is working: its last run has not ended. Stop it first, or --force if it was killed` };
  const plans: Plan[] = [];
  for (const cwd of [...new Set(since(t, run).map((x) => x.cwd))]) {
    const snapshots = deps.open(cwd);
    if (!snapshots) return { error: `no snapshots for ${cwd}, so its files cannot go back` };
    const p = plan(t, run, cwd, snapshots);
    if (p) plans.push(p);
  }
  const name = (p: Plan, f: string) => (p.cwd === run.cwd ? f : join(p.cwd, f));
  const moved = plans.flatMap((p) => p.moved.map((f) => name(p, f)));
  if (moved.length && !opts.force) return { error: `${list(moved)} changed since the run that last wrote ${moved.length === 1 ? 'it' : 'them'}; nothing was rewound. --force puts ${moved.length === 1 ? 'it' : 'them'} back too` };
  // The conversation first: a session that cannot be copied leaves everything as it was.
  const sessionId = run.from ? crypto.randomUUID() : undefined;
  const path = sessionId && deps.sessionFile(run.cwd, sessionId);
  if (run.from && path) copySession(run.from, path);
  for (const p of plans) p.snapshots.restoreFiles(p.target, p.todo);
  const restored = plans.flatMap((p) => p.todo.map((f) => name(p, f)));
  store.append(thread, { kind: 'rewind', run: run.id });
  if (run.from && sessionId && path) store.append(thread, { kind: 'session', sessionId, model: run.from.model, role: 'code', why: 'rewind', path });
  // Back to before the first run: nothing is going on, and nothing has been done.
  if (n === 1) store.append(thread, { kind: 'state', state: 'stopped' });
  store.send(thread, 'user', rewoundNote(run, restored));
  return { run, restored, ...(sessionId ? { sessionId } : {}) };
}

const list = (xs: string[]) => xs.join(', ');

// What the user is told.
export function rewoundText(r: Rewound): string {
  const lines = [`rewound to before run ${JSON.stringify(clip(r.run.prompt))}${r.sessionId ? `; the thread goes on in session ${r.sessionId}` : '; the next run starts a new session from the task'}`];
  if (r.restored.length) lines.push(`put back ${list(r.restored)}`);
  lines.push('only files were put back: commands those runs ran, and anything outside the working tree, stay as they are');
  return lines.join('\n');
}

// What the model is told at its next turn.
export function rewoundNote(run: Run, restored: string[]): string {
  const put = restored.length ? ` ${list(restored)} ${restored.length === 1 ? 'is' : 'are'} back to how ${restored.length === 1 ? 'it was' : 'they were'} then.` : '';
  return `I rewound this thread to just before I asked: "${clip(run.prompt)}". What happened from there on is gone from the conversation.${put} Commands run since then and anything outside the working tree are as they were, so read a file again before you edit it.`;
}

const clip = (s: string) => {
  const line = s.trim().split('\n')[0]!;
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
};

// One line per run, for `threads show` and `threads rewind` without a number.
export const runLines = (t: Thread) => t.runs.map((r: Extract<ThreadEvent, { kind: 'run' }>, i) => `run ${i + 1}  ${r.at}  ${clip(r.prompt)}`);
