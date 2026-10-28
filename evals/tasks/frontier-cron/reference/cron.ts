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

type Field = { min: number; max: number; names?: string[] };
const FIELDS: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
];

function value(s: string, f: Field): number {
  const named = f.names?.indexOf(s.toUpperCase()) ?? -1;
  if (named >= 0) return named + (f.min === 1 ? 1 : 0);
  if (!/^\d+$/.test(s)) throw new RangeError(`not a value: ${s}`);
  const n = Number(s);
  if (n < f.min || n > f.max) throw new RangeError(`${n} is out of ${f.min}-${f.max}`);
  return n;
}

function field(text: string, f: Field): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [span, stepText, extra] = item.split("/");
    if (extra !== undefined || !span) throw new RangeError(`bad item: ${item}`);
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) throw new RangeError(`bad step: ${item}`);
    let lo: number;
    let hi: number;
    if (span === "*") [lo, hi] = [f.min, f.max];
    else if (span.includes("-")) {
      const [a, b, more] = span.split("-");
      if (more !== undefined || !a || !b) throw new RangeError(`bad range: ${span}`);
      [lo, hi] = [value(a, f), value(b, f)];
      if (lo > hi) throw new RangeError(`range runs backwards: ${span}`);
    } else {
      lo = value(span, f);
      hi = stepText === undefined ? lo : f.max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const all = (s: Set<number>, min: number, max: number) => {
  for (let v = min; v <= max; v++) if (!s.has(v)) return false;
  return true;
};

export function nextRun(expr: string, after: Date): Date {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new RangeError(`expected 5 fields, got ${parts.length}`);
  const [minutes, hours, doms, months, dowsRaw] = parts.map((p, i) => field(p, FIELDS[i]!));
  const dows = new Set([...dowsRaw!].map((d) => d % 7));
  const domAll = all(doms!, 1, 31);
  const dowAll = all(dows, 0, 6);
  const dayOk = (d: Date) => {
    const inDom = doms!.has(d.getUTCDate());
    const inDow = dows.has(d.getUTCDay());
    return domAll ? inDow : dowAll ? inDom : inDom || inDow;
  };

  const t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  // Eight years covers every day of every month, the 29th of February included.
  const end = Date.UTC(t.getUTCFullYear() + 8, 0, 1);
  while (t.getTime() < end) {
    if (!months!.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!dayOk(t)) {
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
