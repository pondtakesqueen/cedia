import type { Snapshots } from '../safety/snapshot.ts';
import { SessionLog, sessionExists } from '../session/log.ts';
import type { EventOf, SessionEvent } from '../types.ts';
import type { ThreadStore } from './threads.ts';

// `/undo` and `/redo` of the last turn's files, from the shadow snapshots (core/safety/snapshot.ts). A turn is a
// user prompt and the run that answered it; its writing calls ran between the snapshot taken before the first of
// them and the one after the last. Undo puts the files that changed between the two back to the first; redo puts
// them forward again. A file that changed again since (the user's own edit, another run) is left alone unless
// forced, so an undo never takes back work it did not do. Commands the turn ran, and anything outside the
// working tree, are not undone, and the note says so.

// The trees around the last turn that changed files, in one session's log.
// `cwd` is the session's: each worktree of a project has its own snapshots.
export type TurnChange = { sessionId: string; cwd: string; before: string; after: string };

// What an undo or redo did: the files it put back, and the ones it left because they changed since.
export type Restored = { action: 'undo' | 'redo'; restored: string[]; skipped: string[] };

export function lastTurnChange(sessionId: string, events: SessionEvent[]): TurnChange | undefined {
  // Every user prompt starts a turn; the last one that took snapshots is the turn to undo.
  let snaps: EventOf<'snapshot'>[] = [];
  let last: EventOf<'snapshot'>[] = [];
  for (const e of events) {
    if (e.kind === 'user') {
      if (snaps.length > 1) last = snaps;
      snaps = [];
    } else if (e.kind === 'snapshot' && e.tree) snaps.push(e);
  }
  if (snaps.length > 1) last = snaps;
  const head = events[0];
  if (last.length < 2 || head?.kind !== 'session') return undefined;
  return { sessionId, cwd: head.cwd, before: last[0]!.tree, after: last.at(-1)!.tree };
}

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

// The last turn of a thread that changed files: its last writer session's. Undefined when there is none.
export function threadTurn(store: ThreadStore, thread: string): TurnChange | undefined {
  const last = store.read(thread).sessions.findLast((s) => s.role === 'code' && s.path && sessionExists(s.path));
  return last ? lastTurnChange(last.sessionId, SessionLog.load(last.path!).events) : undefined;
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
