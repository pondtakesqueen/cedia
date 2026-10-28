import { readFileSync, writeFileSync } from 'node:fs';

// What the person picked from the `/` and `@` menus, so the menus can put
// their usual picks first. Each pick counts for less as it ages (a weight
// that halves every HALF_LIFE_MS), so a command used a lot last month gives
// way to one used this week. Kept as `{ value: [epoch ms, ...] }`, newest
// last, at most MAX_PER_VALUE times per value and MAX_VALUES values.
export type PickLog = Record<string, number[]>;

const HALF_LIFE_MS = 7 * 24 * 3600_000;
const MAX_PER_VALUE = 20;
const MAX_VALUES = 300;
// buildAutoItems ranks prefix matches below 1000 and the rest from 1000 up,
// so a boost stays under that gap and never lifts a fuzzy match over a prefix one.
const MAX_BOOST = 900;
const BOOST_PER_PICK = 150;

export function readPicks(path: string): PickLog {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: PickLog = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((t): t is number => typeof t === 'number');
    }
    return out;
  } catch {
    return {};
  }
}

export function addPick(log: PickLog, value: string, now = Date.now()): PickLog {
  const next: PickLog = { ...log, [value]: [...(log[value] ?? []), now].slice(-MAX_PER_VALUE) };
  const keys = Object.keys(next);
  if (keys.length <= MAX_VALUES) return next;
  const newest = (k: string) => next[k]![next[k]!.length - 1] ?? 0;
  const kept = keys.sort((a, b) => newest(b) - newest(a)).slice(0, MAX_VALUES);
  return Object.fromEntries(kept.map((k) => [k, next[k]!]));
}

export function savePick(path: string, value: string, now = Date.now()): void {
  try {
    writeFileSync(path, JSON.stringify(addPick(readPicks(path), value, now)));
  } catch {
    // A menu ranking is a convenience: a read-only home just keeps the default order.
  }
}

export function pickBoost(log: PickLog, value: string, now = Date.now()): number {
  const times = log[value];
  if (!times?.length) return 0;
  const weight = times.reduce((sum, t) => sum + 0.5 ** (Math.max(0, now - t) / HALF_LIFE_MS), 0);
  return Math.min(MAX_BOOST, Math.round(weight * BOOST_PER_PICK));
}
