import type { Snapshots } from '../safety/snapshot.ts';
import type { EventOf, SessionEvent } from '../types.ts';
import type { ThreadStore } from './threads.ts';

// `/undo` and `/redo` of the last turn's files, from the shadow snapshots (core/safety/snapshot.ts). A turn is one
// run of a thread (one prompt): its writing calls ran between the snapshot taken before the first of them and the
// one after the last, in whichever of the run's sessions they fell (a handoff, a fallback, a review's fix), and
// the run records both trees in the thread (`turn` event). Undo puts the files that changed between the two back to the first; redo puts
// them forward again. A file that changed again since (the user's own edit, another run) is left alone unless
// forced, so an undo never takes back work it did not do. Commands the turn ran, and anything outside the
// working tree, are not undone, and the note says so.

// The trees around the last turn that changed files, in one session's log.
// `cwd` is the session's: each worktree of a project has its own snapshots.
export type TurnChange = { sessionId: string; cwd: string; before: string; after: string };

// What an undo or redo did: the files it put back, and the ones it left because they changed since.
// `threads undo|redo <id> --json` prints it.
export type Restored = { action: 'undo' | 'redo'; restored: string[]; skipped: string[] };

// Puts the files the turn changed to `target`. A file already there is left out; one that no longer matches
// `expected` (how the other side of the turn has it) changed since, and is skipped unless forced.
function put(snapshots: Snapshots, change: TurnChange, action: Restored['action'], opts: { force?: boolean }): Restored {
  const [target, expected] = action === 'undo' ? [change.before, change.after] : [change.after, change.before];
  const files = snapshots.diff(change.before, change.after);
  const now = snapshots.take();
  if (!now) throw new Error('cannot snapshot the working tree');
  const away = new Set(snapshots.diff(target, now));
  const moved = new Set(snapshots.diff(expected, now));
  const todo = files.filter((f) => away.has(f));
  const skipped = opts.force ? [] : todo.filter((f) => moved.has(f));
  const restored = todo.filter((f) => !skipped.includes(f));
  snapshots.restoreFiles(target, restored);
  return { action, restored, skipped };
}

export const undoTurn = (snapshots: Snapshots, change: TurnChange, opts: { force?: boolean } = {}) => put(snapshots, change, 'undo', opts);
export const redoTurn = (snapshots: Snapshots, change: TurnChange, opts: { force?: boolean } = {}) => put(snapshots, change, 'redo', opts);

// The change since the turn started, for `/diff`: the turn's first tree against the working tree now.
export function sinceTurn(snapshots: Snapshots, change: TurnChange): string {
  const now = snapshots.take();
  if (!now) throw new Error('cannot snapshot the working tree');
  return snapshots.patch(change.before, now, { context: 3 });
}

// What the user is told.
export function restoredText(r: Restored): string {
  const verb = r.action === 'undo' ? 'undid' : 'redid';
  const lines = r.restored.length ? [`${verb} ${r.restored.join(', ')}`] : r.skipped.length ? [] : [`nothing to ${r.action}: the files are already there`];
  if (r.skipped.length) lines.push(`left ${r.skipped.join(', ')}: changed since the turn (--force puts ${r.skipped.length === 1 ? 'it' : 'them'} back anyway)`);
  if (r.action === 'undo' && r.restored.length) lines.push('only files were put back: commands the turn ran, and anything outside the working tree, stay as they are');
  return lines.join('\n');
}

// What the model is told at its next turn, through the thread's inbox: files it wrote are not as it left them.
export function restoredNote(r: Restored): string {
  const list = (xs: string[]) => xs.join(', ');
  const head =
    r.action === 'undo'
      ? `I ran /undo on your last turn: ${list(r.restored)} ${r.restored.length === 1 ? 'is' : 'are'} back to how ${r.restored.length === 1 ? 'it was' : 'they were'} before it.`
      : `I ran /redo: ${list(r.restored)} ${r.restored.length === 1 ? 'is' : 'are'} back to how your last turn left ${r.restored.length === 1 ? 'it' : 'them'}.`;
  const skipped = r.skipped.length ? ` ${list(r.skipped)} changed after your turn, so ${r.skipped.length === 1 ? 'it was' : 'they were'} left as ${r.skipped.length === 1 ? 'it is' : 'they are'}.` : '';
  return `${head}${skipped} Only files were put back: commands the turn ran and anything outside the working tree are as they were. Read a file again before you edit it.`;
}

// The last run of a thread that changed files. Undefined when there is none.
export function threadTurn(store: ThreadStore, thread: string): TurnChange | undefined {
  const t = store.read(thread).lastTurn;
  return t ? { sessionId: t.sessions.at(-1) ?? '', cwd: t.cwd, before: t.before, after: t.after } : undefined;
}

// The trees around a run's writes, from its writer sessions' snapshots (each from where the run started in it).
export function runTurn(runs: { events: SessionEvent[]; from: number }[]): { before: string; after: string } | undefined {
  const snaps = runs.flatMap((r) => r.events.slice(r.from).filter((e): e is EventOf<'snapshot'> => e.kind === 'snapshot' && !!e.tree));
  if (snaps.length < 2 || snaps[0]!.tree === snaps.at(-1)!.tree) return undefined;
  return { before: snaps[0]!.tree, after: snaps.at(-1)!.tree };
}

// Undoes or redoes a thread's last turn in the working directory it ran in, and leaves the model a message saying
// which files moved.
export function restoreTurn(store: ThreadStore, thread: string, open: (cwd: string) => Snapshots | undefined, action: Restored['action'], opts: { force?: boolean } = {}): Restored | { error: string } {
  const change = threadTurn(store, thread);
  if (!change) return { error: `thread ${thread} has no turn that changed files` };
  const snapshots = open(change.cwd);
  if (!snapshots) return { error: `no snapshots for ${change.cwd}` };
  const r = action === 'undo' ? undoTurn(snapshots, change, opts) : redoTurn(snapshots, change, opts);
  if (r.restored.length) store.send(thread, 'user', restoredNote(r));
  return r;
}
