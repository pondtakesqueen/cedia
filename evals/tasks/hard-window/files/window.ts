export interface Event {
  t: number;
  key: string;
}

/**
 * For each event, the number of distinct keys among all events whose time is in its window: after `t - windowMs`
 * and at or before `t`. "All events" means the whole list, whatever its order: a later entry with the same or
 * an earlier time is in the window too. The result has one count per event, in the order of `events`.
 *
 * `windowMs` must be a finite number above 0, else a RangeError. Every `t` must be a finite number, else a
 * TypeError that names the index of the first bad event. Keys are compared exactly, as strings.
 */
export function distinctInWindow(events: Event[], windowMs: number): number[] {
  if (!(Number.isFinite(windowMs) && windowMs > 0)) throw new RangeError(`windowMs must be a finite number above 0, got ${windowMs}`);
  events.forEach((e, i) => {
    if (typeof e.t !== "number" || !Number.isFinite(e.t)) throw new TypeError(`event ${i} has no finite time: ${e.t}`);
  });
  return events.map((e) => {
    const keys = new Set<string>();
    for (const other of events) if (other.t > e.t - windowMs && other.t <= e.t) keys.add(other.key);
    return keys.size;
  });
}
