import { describe, expect, test } from "vitest";
import {
  applyQueryConstraints,
  formatQuery,
  formatScraperQuery,
  GOOGLE_QUERY_SYNTAX,
  matchesQueryConstraints,
  matchesSite,
  parseDateValue,
  parseSearchQuery,
} from "../src/websearch-query.ts";

describe("parseSearchQuery", () => {
  test("plain query has no directives", () => {
    const q = parseSearchQuery("pi extension hooks");
    expect(q.hasDirectives).toBe(false);
    expect(q.hasConstraints).toBe(false);
    expect(q.text).toBe("pi extension hooks");
  });
  test("parses site and exclusion", () => {
    const q = parseSearchQuery("site:github.com pi -site:spam.example");
    expect(q.sites).toEqual(["github.com"]);
    expect(q.excludedSites).toEqual(["spam.example"]);
  });
  test("parses intitle, inurl, filetype", () => {
    const q = parseSearchQuery('intitle:budget inurl:docs filetype:pdf "exact phrase"');
    expect(q.inTitle).toEqual(["budget"]);
    expect(q.inUrl).toEqual(["docs"]);
    expect(q.filetypes).toEqual(["pdf"]);
    expect(q.terms.some((t) => t.phrase && t.text === "exact phrase")).toBe(true);
  });
  test("parses OR groups and negation", () => {
    const q = parseSearchQuery("react OR vue -angular");
    const grouped = q.terms.filter((t) => t.group !== undefined);
    expect(grouped).toHaveLength(2);
    expect(q.terms.some((t) => t.negated && t.text === "angular")).toBe(true);
  });
  test("parses date bounds leniently", () => {
    expect(parseSearchQuery("after:2024 x").after).toBe("2024-01-01");
    expect(parseSearchQuery("before:2024-06 x").before).toBe("2024-06-01");
    expect(parseDateValue("someday")).toBeUndefined();
    expect(parseSearchQuery("before:someday x").before).toBeUndefined();
  });
  test("unknown directives stay as free text", () => {
    const q = parseSearchQuery("TS2345: foo");
    expect(q.hasDirectives).toBe(false);
    expect(q.text).toContain("TS2345:");
  });
});

describe("formatQuery", () => {
  test("round trips full syntax", () => {
    const q = parseSearchQuery('site:github.com intitle:budget "exact" -spam');
    const out = formatQuery(q, GOOGLE_QUERY_SYNTAX);
    expect(out).toContain("site:github.com");
    expect(out).toContain("intitle:budget");
    expect(out).toContain('"exact"');
    expect(out).toContain("-spam");
  });
  test("directives-only query never returns empty", () => {
    expect(formatQuery(parseSearchQuery("site:github.com"), {})).toBe("github.com");
  });
});

describe("formatScraperQuery", () => {
  test("plain query passes through byte-identical", () => {
    expect(formatScraperQuery("pi hooks")).toBe("pi hooks");
  });
  test("demotes path sites and inurl into keywords", () => {
    const out = formatScraperQuery("site:github.com/anthropics pi inurl:docs");
    expect(out).toContain("pi");
    expect(out).toContain("github.com/anthropics");
    expect(out).toContain("docs");
    expect(out).not.toMatch(/inurl:/);
  });
  test("keeps bare domain site", () => {
    expect(formatScraperQuery("site:github.com pi")).toContain("site:github.com");
  });
});

describe("matchesSite", () => {
  test("matches subdomains and paths", () => {
    expect(matchesSite("https://api.github.com/x", "github.com")).toBe(true);
    expect(matchesSite("https://github.com/anthropics/y", "github.com/anthropics")).toBe(true);
    expect(matchesSite("https://github.com/other/y", "github.com/anthropics")).toBe(false);
  });
});

describe("applyQueryConstraints", () => {
  const sources = [
    { title: "a", url: "https://github.com/x" },
    { title: "budget tips", url: "https://example.com/docs" },
  ];
  test("enforces site and drops nothing when matched", () => {
    const r = applyQueryConstraints(sources, parseSearchQuery("site:github.com pi"));
    expect(r.sources.map((s) => s.title)).toEqual(["a"]);
    expect(r.dropped).toEqual([]);
  });
  test("relaxes a dimension that would empty the set", () => {
    const r = applyQueryConstraints(sources, parseSearchQuery("site:nowhere.example pi"));
    expect(r.sources).toHaveLength(2);
    expect(r.dropped.join(" ")).toContain("site:nowhere.example");
  });
  test("intitle and inurl filter", () => {
    const r = applyQueryConstraints(sources, parseSearchQuery("intitle:budget inurl:docs x"));
    expect(r.sources.map((s) => s.title)).toEqual(["budget tips"]);
  });
  test("matchesQueryConstraints is strict", () => {
    const q = parseSearchQuery("site:github.com x");
    expect(matchesQueryConstraints(sources[0], q)).toBe(true);
    expect(matchesQueryConstraints(sources[1], q)).toBe(false);
  });
});
