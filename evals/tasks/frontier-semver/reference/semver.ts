/**
 * npm-style semantic versions and ranges.
 *
 * Versions (https://semver.org): MAJOR.MINOR.PATCH, then optionally `-` and dot-separated prerelease identifiers,
 * then optionally `+` and build metadata. Numbers have no leading zeros; a numeric prerelease identifier has none
 * either. One leading `v` and surrounding whitespace are allowed. Anything else is not a version.
 *
 * Order: by MAJOR, MINOR, PATCH as numbers; then a version with a prerelease is lower than the same version
 * without one; two prereleases compare identifier by identifier: numeric identifiers as numbers, others in ASCII
 * order, a numeric one lower than a non-numeric one, and when all shared ones are equal the shorter list is lower.
 * Build metadata never counts.
 *
 * A range is one or more comparator sets joined by `||`; a version satisfies the range when it satisfies any set.
 * A set is comparators separated by whitespace, all of which must hold; an empty set (or `*`) is any version.
 * A comparator is an operator (`<`, `<=`, `>`, `>=`, `=`, or none, which means `=`) and a version, with optional
 * whitespace between them. Where a version may be partial, `x`, `X` and `*` stand for a missing part, and missing
 * parts may also be left out (`1`, `1.2`). Partial versions, and the sugar below, mean:
 *
 * - X-ranges: `*` is any version; `1.x` or `1` is `>=1.0.0 <2.0.0-0`; `1.2.x` or `1.2` is `>=1.2.0 <1.3.0-0`.
 * - With an operator: `>1` is `>=2.0.0`, `>1.2` is `>=1.3.0`; `>=1.2` is `>=1.2.0`; `<1.2` is `<1.2.0-0`;
 *   `<=1.2` is `<1.3.0-0`, `<=1` is `<2.0.0-0`; `=1.2` is the same as `1.2`. `>*` and `<*` match nothing.
 * - Tilde: `~1.2.3` is `>=1.2.3 <1.3.0-0`; `~1.2` is `>=1.2.0 <1.3.0-0`; `~1` is `>=1.0.0 <2.0.0-0`;
 *   `~1.2.3-beta.2` is `>=1.2.3-beta.2 <1.3.0-0`.
 * - Caret: allows changes that do not touch the left-most non-zero part. `^1.2.3` is `>=1.2.3 <2.0.0-0`;
 *   `^0.2.3` is `>=0.2.3 <0.3.0-0`; `^0.0.3` is `>=0.0.3 <0.0.4-0`; `^1.2.x` is `>=1.2.0 <2.0.0-0`;
 *   `^0.0.x` and `^0.0` are `>=0.0.0 <0.1.0-0`; `^0.x` and `^0` are `>=0.0.0 <1.0.0-0`; `^1.x` is
 *   `>=1.0.0 <2.0.0-0`; a prerelease keeps its place: `^1.2.3-beta.2` is `>=1.2.3-beta.2 <2.0.0-0` and
 *   `^0.0.3-beta` is `>=0.0.3-beta <0.0.4-0`.
 * - Hyphen ranges (`A - B`, spaces around the hyphen): `>=A <=B`. A partial A fills with zeros (`1.2 - 2.3.4` is
 *   `>=1.2.0 <=2.3.4`); a partial B accepts everything it names (`1.2.3 - 2.3` is `>=1.2.3 <2.4.0-0`,
 *   `1.2.3 - 2` is `>=1.2.3 <3.0.0-0`).
 *
 * Prereleases: a version with a prerelease satisfies a set only when, besides every comparator holding, some
 * comparator of that set has a prerelease on the same MAJOR.MINOR.PATCH. So `1.2.3-beta.4` satisfies
 * `>=1.2.3-alpha` but `3.4.5-beta` does not satisfy `>=1.2.3-alpha`, and no prerelease satisfies `*`. The `-0` the
 * sugar above adds counts like any other prerelease.
 *
 * A version that is not one satisfies nothing, and a range that cannot be read matches nothing.
 */

type Id = string | number;
export type SemVer = { major: number; minor: number; patch: number; prerelease: Id[] };

const NUM = "0|[1-9]\\d*";
const PRE = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const VERSION = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}(?:\\.${PRE})*))?(?:\\+${BUILD})?$`);
const XPART = `${NUM}|x|X|\\*`;
const PARTIAL = new RegExp(`^v?(${XPART})(?:\\.(${XPART})(?:\\.(${XPART})(?:-(${PRE}(?:\\.${PRE})*))?(?:\\+${BUILD})?)?)?$`);

export function parse(v: string): SemVer | null {
  const m = VERSION.exec(v.trim());
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, prerelease: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? +p : p)) : [] };
}

const cmpId = (a: Id, b: Id) => (typeof a === "number" && typeof b === "number" ? a - b : typeof a === "number" ? -1 : typeof b === "number" ? 1 : a < b ? -1 : a > b ? 1 : 0);

export function compare(a: SemVer, b: SemVer): number {
  const main = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (main) return Math.sign(main);
  if (!a.prerelease.length || !b.prerelease.length) return (b.prerelease.length ? 1 : 0) - (a.prerelease.length ? 1 : 0);
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const c = cmpId(a.prerelease[i]!, b.prerelease[i]!);
    if (c) return Math.sign(c);
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

type Op = "<" | "<=" | ">" | ">=" | "=";
type Comparator = { op: Op; v: SemVer } | "any" | "none";
type Partial = { major?: number; minor?: number; patch?: number; prerelease: Id[] };

const isX = (p: string | undefined) => p === undefined || p === "x" || p === "X" || p === "*";

function partial(s: string): Partial | null {
  const m = PARTIAL.exec(s);
  if (!m) return null;
  const n = (p: string | undefined) => (isX(p) ? undefined : +p!);
  const major = n(m[1]);
  const minor = major === undefined ? undefined : n(m[2]);
  const patch = minor === undefined ? undefined : n(m[3]);
  const prerelease = patch !== undefined && m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? +p : p)) : [];
  return { major, minor, patch, prerelease };
}

const ver = (major: number, minor: number, patch: number, prerelease: Id[] = []): SemVer => ({ major, minor, patch, prerelease });
const below = (major: number, minor: number, patch: number): Comparator => ({ op: "<", v: ver(major, minor, patch, [0]) });
const full = (p: Partial) => ver(p.major!, p.minor!, p.patch!, p.prerelease);

function tilde(p: Partial): Comparator[] {
  if (p.major === undefined) return ["any"];
  if (p.minor === undefined) return [{ op: ">=", v: ver(p.major, 0, 0) }, below(p.major + 1, 0, 0)];
  if (p.patch === undefined) return [{ op: ">=", v: ver(p.major, p.minor, 0) }, below(p.major, p.minor + 1, 0)];
  return [{ op: ">=", v: full(p) }, below(p.major, p.minor + 1, 0)];
}

function caret(p: Partial): Comparator[] {
  if (p.major === undefined) return ["any"];
  if (p.minor === undefined) return [{ op: ">=", v: ver(p.major, 0, 0) }, below(p.major + 1, 0, 0)];
  if (p.patch === undefined) return [{ op: ">=", v: ver(p.major, p.minor, 0) }, p.major === 0 ? below(0, p.minor + 1, 0) : below(p.major + 1, 0, 0)];
  const upper = p.major !== 0 ? below(p.major + 1, 0, 0) : p.minor !== 0 ? below(0, p.minor + 1, 0) : below(0, 0, p.patch + 1);
  return [{ op: ">=", v: full(p) }, upper];
}

function withOp(op: Op, p: Partial): Comparator[] {
  if (p.major === undefined) return op === "<" || op === ">" ? ["none"] : ["any"];
  if (p.patch !== undefined) return [{ op, v: full(p) }];
  // A partial version: what the operator means for the whole span it names.
  const xm = p.minor === undefined;
  const minor = p.minor ?? 0;
  switch (op) {
    case "=":
      return xm ? [{ op: ">=", v: ver(p.major, 0, 0) }, below(p.major + 1, 0, 0)] : [{ op: ">=", v: ver(p.major, minor, 0) }, below(p.major, minor + 1, 0)];
    case ">":
      return [{ op: ">=", v: xm ? ver(p.major + 1, 0, 0) : ver(p.major, minor + 1, 0) }];
    case ">=":
      return [{ op: ">=", v: ver(p.major, minor, 0) }];
    case "<":
      return [below(p.major, minor, 0)];
    case "<=":
      return [xm ? below(p.major + 1, 0, 0) : below(p.major, minor + 1, 0)];
  }
}

function hyphen(a: Partial, b: Partial): Comparator[] {
  const from: Comparator[] = a.major === undefined ? [] : [{ op: ">=", v: ver(a.major, a.minor ?? 0, a.patch ?? 0, a.prerelease) }];
  const to: Comparator[] =
    b.major === undefined ? [] : b.minor === undefined ? [below(b.major + 1, 0, 0)] : b.patch === undefined ? [below(b.major, b.minor + 1, 0)] : [{ op: "<=", v: full(b) }];
  const all = [...from, ...to];
  return all.length ? all : ["any"];
}

function parseSet(set: string): Comparator[] | null {
  const s = set.trim().replace(/(<=|>=|<|>|=|~|\^)\s+/g, "$1");
  if (!s) return ["any"];
  const h = /^(\S+)\s+-\s+(\S+)$/.exec(s);
  if (h) {
    const a = partial(h[1]!);
    const b = partial(h[2]!);
    return a && b ? hyphen(a, b) : null;
  }
  const out: Comparator[] = [];
  for (const tok of s.split(/\s+/)) {
    const m = /^(<=|>=|<|>|=|~|\^)?(.*)$/.exec(tok)!;
    const p = partial(m[2]!);
    if (!p) return null;
    const op = m[1] ?? "=";
    out.push(...(op === "~" ? tilde(p) : op === "^" ? caret(p) : withOp(op as Op, p)));
  }
  return out;
}

export function parseRange(range: string): Comparator[][] | null {
  const sets = range.split("||").map(parseSet);
  return sets.some((s) => s === null) ? null : (sets as Comparator[][]);
}

function holds(c: Comparator, v: SemVer): boolean {
  if (c === "any") return true;
  if (c === "none") return false;
  const d = compare(v, c.v);
  return c.op === "<" ? d < 0 : c.op === "<=" ? d <= 0 : c.op === ">" ? d > 0 : c.op === ">=" ? d >= 0 : d === 0;
}

function testSet(set: Comparator[], v: SemVer): boolean {
  if (!set.every((c) => holds(c, v))) return false;
  if (!v.prerelease.length) return true;
  return set.some((c) => typeof c !== "string" && c.v.prerelease.length > 0 && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch);
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  const sets = parseRange(range);
  return !!v && !!sets && sets.some((s) => testSet(s, v));
}

/** The highest of `versions` that satisfies `range`, as given, or null when none does. Non-versions are skipped. */
export function maxSatisfying(versions: string[], range: string): string | null {
  let best: { s: string; v: SemVer } | null = null;
  for (const s of versions) {
    const v = parse(s);
    if (v && satisfies(s, range) && (!best || compare(v, best.v) > 0)) best = { s, v };
  }
  return best?.s ?? null;
}
