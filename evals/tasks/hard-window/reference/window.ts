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
  // Sort indexes by time, then sweep groups of equal times: add the whole group, drop what fell out, record.
  const order = events.map((_, i) => i).sort((a, b) => events[a].t - events[b].t);
  const counts = new Map<string, number>();
  const out = new Array<number>(events.length);
  let lo = 0;
  for (let hi = 0; hi < order.length; ) {
    const t = events[order[hi]].t;
    let end = hi;
    while (end < order.length && events[order[end]].t === t) {
      const k = events[order[end]].key;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      end++;
    }
    while (events[order[lo]].t <= t - windowMs) {
      const k = events[order[lo]].key;
      const c = counts.get(k)! - 1;
      if (c === 0) counts.delete(k);
      else counts.set(k, c);
      lo++;
    }
    for (let i = hi; i < end; i++) out[order[i]] = counts.size;
    hi = end;
  }
  return out;
}
