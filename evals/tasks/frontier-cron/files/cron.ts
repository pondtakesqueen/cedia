/**
 * When a cron expression fires next, in UTC.
 *
 * An expression is five fields separated by whitespace: minute (0-59), hour (0-23), day of month (1-31), month
 * (1-12, or JAN-DEC) and day of week (0-7, where 0 and 7 are both Sunday, or SUN-SAT). Names are not case
 * sensitive. A field is a comma-separated list of items, and an item is one of:
 *
 * - `*`: every value of the field;
 * - `n`: that value; `a-b`: every value from a to b (a must not be above b);
 * - any of those followed by `/s` (s of 1 or more): from the item's first value, every s-th value up to its last.
 *   `0-59/15` (or a star followed by `/15`) in the minute field is 0, 15, 30, 45; `10-30/10` is 10, 20, 30; `5/20`
 *   is 5, 25, 45 (from 5 to the end of the field).
 *
 * A time matches when its minute, hour and month are in their fields and its day matches. The day rule: when the
 * day-of-month field or the day-of-week field allows every value of its range (written `*` or not, so `1-31` and
 * `0-6` count), the day must be in the other one; when both leave some value out, the day matches if it is in
 * either one (`0 0 1,15 * 1` fires on the 1st, the 15th and every Monday).
 *
 * `nextRun(expr, after)` is the first whole minute strictly after `after` that matches. It throws a RangeError for
 * an expression that does not follow the rules above (wrong number of fields, a value out of its range, a step of
 * 0, a range that runs backwards, an unknown name) and for one that never fires, such as `0 0 30 2 *`.
 */


const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function field(text: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [span, stepText] = item.split("/");
    const step = Number(stepText) || 1;
    let lo = min;
    let hi = max;
    if (span !== "*") {
      const [a, b] = span!.split("-");
      lo = Number(a);
      hi = b === undefined ? lo : Number(b);
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max) throw new RangeError(`bad field: ${text}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function nextRun(expr: string, after: Date): Date {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new RangeError(`expected 5 fields, got ${parts.length}`);
  const [minutes, hours, doms, months, dows] = parts.map((p, i) => field(p, RANGES[i]!));
  const t = new Date(after.getTime() + 60_000);
  t.setUTCSeconds(0, 0);
  // A year ahead is enough to find any time.
  const end = after.getTime() + 366 * 24 * 3600_000;
  while (t.getTime() < end) {
    if (!months!.has(t.getUTCMonth() + 1) || !doms!.has(t.getUTCDate()) || !dows!.has(t.getUTCDay())) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!hours!.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    } else if (!minutes!.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    } else return t;
  }
  throw new RangeError(`${expr} never fires`);
}
