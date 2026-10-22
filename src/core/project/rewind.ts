import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Snapshots } from '../safety/snapshot.ts';
import { sessionExists } from '../session/log.ts';
import type { Thread, ThreadEvent, ThreadStore } from './threads.ts';

// `/rewind`: the thread goes back to just before one of its runs, conversation and files together. Each run
// records where it started (a `run` event: the working tree's snapshot, and the writer session with how many
// events it had), so going back is:
//
//   files         every file a run since then changed (the `turn` events) is put back to the tree the run started
//                 from. One that changed again after the last run that wrote it (the user's own edit) is left
//                 unless forced, as /undo does.
//   conversation  a new session whose log is a copy of that session's first events, byte for byte, so its cached
//                 prefix is the same; the thread goes on in it. A rewind to the first run leaves no session: the
//                 next run starts a new one from the task.
//   the thread    a `rewind` event: its fold drops what happened from the run on (sessions, turns, results,
//                 deliveries), keeping the messages, so one delivered only to a dropped session waits again.
//
// The model is told at its next turn, through the thread's inbox, since commands those runs ran and anything outside
// the working tree are as they were. The dropped sessions' logs stay on disk, and recall no longer searches them.

export type Run = Thread['runs'][number];
export type Rewound = { run: Run; restored: string[]; skipped: string[]; sessionId?: string };

// The files the runs since `run` changed, and the tree each was in after the last of them that changed it.
const since = (t: Thread, run: Run) => t.turns.filter((x) => x.runs > t.runs.indexOf(run) && x.cwd === run.cwd);

function changedSince(snapshots: Snapshots, t: Thread, run: Run): Map<string, string> {
  const last = new Map<string, string>();
  for (const turn of since(t, run)) for (const f of snapshots.diff(turn.before, turn.after)) last.set(f, turn.after);
  return last;
}

// Puts the files back. `target` is the tree the run started from (or, for a run recorded without one, the tree the
// first change since started from).
function restoreFiles(snapshots: Snapshots, t: Thread, run: Run, opts: { force?: boolean }): { restored: string[]; skipped: string[] } {
  const last = changedSince(snapshots, t, run);
  const target = run.tree ?? since(t, run)[0]?.before;
  if (!target || !last.size) return { restored: [], skipped: [] };
  const now = snapshots.take();
  if (!now) throw new Error('cannot snapshot the working tree');
  const away = new Set(snapshots.diff(target, now));
  const todo = [...last.keys()].filter((f) => away.has(f)).sort();
  // Per tree a file was last left in, which of those files no longer match it.
  const moved = new Set<string>();
  for (const tree of new Set(last.values())) for (const f of snapshots.diff(tree, now)) if (last.get(f) === tree) moved.add(f);
  const skipped = opts.force ? [] : todo.filter((f) => moved.has(f));
  const restored = todo.filter((f) => !skipped.includes(f));
  snapshots.restoreFiles(target, restored);
  return { restored, skipped };
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
// snapshots of a working directory; `sessionFile` the path for a new session's log.
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
  const snapshots = deps.open(run.cwd);
  if (!snapshots && since(t, run).length) return { error: `no snapshots for ${run.cwd}, so its files cannot go back` };
  // The conversation first: a session that cannot be copied leaves everything as it was.
  const sessionId = run.from ? crypto.randomUUID() : undefined;
  const path = sessionId && deps.sessionFile(run.cwd, sessionId);
  if (run.from && path) copySession(run.from, path);
  const files = snapshots ? restoreFiles(snapshots, t, run, opts) : { restored: [], skipped: [] };
  store.append(thread, { kind: 'rewind', run: run.id });
  if (run.from && sessionId && path) store.append(thread, { kind: 'session', sessionId, model: run.from.model, role: 'code', why: 'rewind', path });
  store.send(thread, 'user', rewoundNote(run, files));
  return { run, ...files, ...(sessionId ? { sessionId } : {}) };
}

const list = (xs: string[]) => xs.join(', ');

// What the user is told.
export function rewoundText(r: Rewound): string {
  const lines = [`rewound to before run ${JSON.stringify(clip(r.run.prompt))}${r.sessionId ? `; the thread goes on in session ${r.sessionId}` : '; the next run starts a new session from the task'}`];
  if (r.restored.length) lines.push(`put back ${list(r.restored)}`);
  if (r.skipped.length) lines.push(`left ${list(r.skipped)}: changed since the run that wrote ${r.skipped.length === 1 ? 'it' : 'them'} (--force puts ${r.skipped.length === 1 ? 'it' : 'them'} back anyway)`);
  lines.push('only files were put back: commands those runs ran, and anything outside the working tree, stay as they are');
  return lines.join('\n');
}

// What the model is told at its next turn.
export function rewoundNote(run: Run, files: { restored: string[]; skipped: string[] }): string {
  const put = files.restored.length ? ` ${list(files.restored)} ${files.restored.length === 1 ? 'is' : 'are'} back to how ${files.restored.length === 1 ? 'it was' : 'they were'} then.` : '';
  const left = files.skipped.length ? ` ${list(files.skipped)} changed after those runs, so ${files.skipped.length === 1 ? 'it was' : 'they were'} left as ${files.skipped.length === 1 ? 'it is' : 'they are'}.` : '';
  return `I rewound this thread to just before I asked: "${clip(run.prompt)}". What happened from there on is gone from the conversation.${put}${left} Commands run since then and anything outside the working tree are as they were, so read a file again before you edit it.`;
}

const clip = (s: string) => {
  const line = s.trim().split('\n')[0]!;
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
};

// One line per run, for `threads show` and `threads rewind` without a number.
export const runLines = (t: Thread) => t.runs.map((r: Extract<ThreadEvent, { kind: 'run' }>, i) => `run ${i + 1}  ${r.at}  ${clip(r.prompt)}`);
