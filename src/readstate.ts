import { statSync } from "node:fs";

export interface ReadEntry {
  mtimeMs: number;
}

export interface ReadState {
  entries: Map<string, ReadEntry>;
}

export function emptyReadState(): ReadState {
  return { entries: new Map() };
}

/** Record that `path` was read; store its current mtime (floor). */
export function recordRead(state: ReadState, path: string): void {
  try {
    state.entries.set(path, { mtimeMs: Math.floor(statSync(path).mtimeMs) });
  } catch {
    // File may not exist yet (read of missing file); still mark as read attempt.
    state.entries.set(path, { mtimeMs: 0 });
  }
}

export function wasRead(state: ReadState, path: string): boolean {
  return state.entries.has(path);
}

/** True if the file's mtime moved since it was read (content likely changed). */
export function isStale(state: ReadState, path: string): boolean {
  const entry = state.entries.get(path);
  if (!entry) return false;
  try {
    return Math.floor(statSync(path).mtimeMs) !== entry.mtimeMs;
  } catch {
    return true;
  }
}