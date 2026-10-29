// The recap the TUI shows when the owner comes back to turns that ran without them (core/project/recap.ts). The
// owner is present when the terminal sends anything but a blur report: a key, a paste, the mouse, focus coming back.
// A turn (and whatever queued behind it) that ends at least AWAY_MS after that gets a recap: at once while the
// terminal has focus or never said, since the end of the transcript is what the owner reads on return; when the
// terminal is blurred, on the owner's next sign of presence, so it is the newest thing on screen then.
import { awayRecap, formatRecap } from '../../core/project/recap.ts';
import type { ThreadStore } from '../../core/project/threads.ts';
import type { Focus } from './notify.ts';

export const AWAY_MS = 3 * 60_000;

export type PendingRecap = { thread: string; since: number };

/** Whether this terminal input says the owner is here: anything but a lone blur report. */
export function presentIn(data: string): boolean {
  return data.replace(/\x1b\[O/g, '').length > 0;
}

/** What to do with a recap when the turns end: show it now, hold it for the owner's return, or none. */
export function recapWhen(lastSeen: number, now: number, focus: Focus): 'now' | 'on-return' | undefined {
  if (now - lastSeen < AWAY_MS) return undefined;
  return focus === 'blurred' ? 'on-return' : 'now';
}

/** The recap's text, or nothing when the thread has no run in the span. */
export function awayText(store: ThreadStore, p: PendingRecap, cwd: string, home?: string): string | undefined {
  try {
    if (!store.has(p.thread)) return undefined;
    const r = awayRecap(store.read(p.thread), new Date(p.since), { cwd, ...(home ? { home } : {}) });
    return r.runs.length ? formatRecap(r, 'while you were away') : undefined;
  } catch {
    return undefined;
  }
}
