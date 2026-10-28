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

export function parse(v: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, prerelease: m[4] ? m[4].split(".") : [] };
}

export function compare(a: SemVer, b: SemVer): number {
  const main = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (main) return Math.sign(main);
  const pa = a.prerelease.join(".");
  const pb = b.prerelease.join(".");
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

type Op = "<" | "<=" | ">" | ">=" | "=";
type Comparator = { op: Op; v: SemVer };

// Missing parts count as 0.
function loose(s: string): SemVer | null {
  const parts = s.replace(/^v/, "").split(".");
  while (parts.length < 3) parts.push("0");
  return parse(parts.map((p) => (p === "x" || p === "X" || p === "*" ? "0" : p)).join("."));
}

function parseSet(set: string): Comparator[] | null {
  const out: Comparator[] = [];
  for (const tok of set.trim().split(/\s+/)) {
    if (!tok || tok === "*") continue;
    const m = /^(<=|>=|<|>|=|~|\^)?(.*)$/.exec(tok)!;
    const v = loose(m[2]!);
    if (!v) return null;
    if (m[1] === "^") out.push({ op: ">=", v }, { op: "<", v: { major: v.major + 1, minor: 0, patch: 0, prerelease: [] } });
    else if (m[1] === "~") out.push({ op: ">=", v }, { op: "<", v: { major: v.major, minor: v.minor + 1, patch: 0, prerelease: [] } });
    else out.push({ op: (m[1] ?? "=") as Op, v });
  }
  return out;
}

function holds(c: Comparator, v: SemVer): boolean {
  const d = compare(v, c.v);
  return c.op === "<" ? d < 0 : c.op === "<=" ? d <= 0 : c.op === ">" ? d > 0 : c.op === ">=" ? d >= 0 : d === 0;
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return range.split("||").some((set) => {
    const cs = parseSet(set);
    return !!cs && cs.every((c) => holds(c, v));
  });
}

/** The highest of `versions` that satisfies `range`, as given, or null when none does. Non-versions are skipped. */
export function maxSatisfying(versions: string[], range: string): string | null {
  const ok = versions.filter((s) => satisfies(s, range));
  ok.sort((a, b) => compare(parse(b)!, parse(a)!));
  return ok[0] ?? null;
}
