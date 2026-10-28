// The desktop's lock (SPEC "Desktop", decided 2026-10-28): where the desktop's daemon runs, it runs the projects'
// queued threads and due schedules, and `cedia daemon` yields to it so no thread starts twice. The desktop writes
// `~/.cedia/desktop.lock` while it serves and removes it when it stops; cedia only reads it. A lock whose process is
// gone (the desktop was killed) holds nothing, so `cedia daemon` goes on.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome } from '../config.ts';
import { isAlive } from './background.ts';

// What the desktop writes: its daemon's pid and when it took the lock.
export type DesktopLock = { pid: number; at: string };

export const desktopLockPath = (home = cediaHome()) => join(home, 'desktop.lock');

// The live holder, or null when there is none: no file, one that does not parse, or a process that is gone.
export function desktopLockHolder(home = cediaHome()): DesktopLock | null {
  const path = desktopLockPath(home);
  if (!existsSync(path)) return null;
  let lock: Partial<DesktopLock>;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8')) as Partial<DesktopLock>;
  } catch {
    return null;
  }
  if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || lock.pid <= 0 || !isAlive(lock.pid)) return null;
  return { pid: lock.pid, at: typeof lock.at === 'string' ? lock.at : '' };
}
