import { existsSync, rmSync } from 'node:fs';
import type { ThreadStore } from './threads.ts';

// Deleting a thread, for a client's thread list: its file goes, with its sub-threads' files and the session logs
// they name, so nothing of it is left to read, list or bill. Unlike archiving it cannot be undone. Kept: a session
// log another thread names too, the blobs its images point at (they are shared by hash) and any worktree it ran in
// (git's, with work the person may still want).
//
// A thread whose run is going on is refused unless `force`: the run would go on writing to files that are gone.

export type Deleted = { threads: string[]; sessions: string[] };
// What `cedia threads delete --json` prints: what went, or why nothing did.
export type DeleteResult = Deleted | { error: string };

export function deleteThread(store: ThreadStore, id: string, opts: { force?: boolean } = {}): DeleteResult {
  if (!store.has(id)) return { error: `no thread ${id} in this project` };
  const all = store.list();
  // The thread and every sub-thread under it, the thread first.
  const doomed = [id];
  for (let i = 0; i < doomed.length; i++) for (const t of all) if (t.parent === doomed[i] && !doomed.includes(t.id)) doomed.push(t.id);
  const threads = doomed.flatMap((d) => all.filter((t) => t.id === d));
  const busy = threads.find((t) => t.running);
  if (busy && !opts.force) return { error: `thread ${busy.id} is running; stop it first, or pass --force` };
  const elsewhere = new Set(all.filter((t) => !doomed.includes(t.id)).flatMap((t) => t.sessions.map((s) => s.sessionId)));
  const sessions: string[] = [];
  for (const t of threads)
    for (const s of t.sessions) {
      if (!s.path || elsewhere.has(s.sessionId) || sessions.includes(s.path)) continue;
      if (existsSync(s.path)) rmSync(s.path, { force: true });
      sessions.push(s.path);
    }
  for (const t of doomed) store.remove(t);
  return { threads: doomed, sessions };
}
