import { describe, expect, test, vi, afterEach } from "vitest";
import {
  applyDomainFilter,
  formatAllFailures,
  formatSearchResponse,
  normalizeDomains,
  searchChain,
  toLegacyResults,
  toSources,
} from "../src/websearch.ts";
import { parseDuckDuckGoHtml, relaxQuery, TavilyProvider } from "../src/websearch-providers.ts";
import type { SearchProvider } from "../src/websearch-providers.ts";

function stubProvider(
  id: string,
  response: { answer?: string; sources?: { title: string; url: string; snippet?: string }[] } | Error,
  available = true,
): SearchProvider {
  return {
    id: id as SearchProvider["id"],
    label: id,
    isAvailable: () => available,
    search: async (params) => {
      if (response instanceof Error) throw response;
      return { query: params.query, provider: id as SearchProvider["id"], answer: response.answer, sources: response.sources ?? [] };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeDomains", () => {
  test("lowercases and dedupes", () => {
    expect(normalizeDomains(["GitHub.COM", "github.com", " "])).toEqual(["github.com"]);
  });
  test("empty input stays empty", () => {
    expect(normalizeDomains(undefined)).toEqual([]);
  });
});

describe("applyDomainFilter", () => {
  const sources = [
    { title: "a", url: "https://github.com/x" },
    { title: "b", url: "https://api.github.com/y" },
    { title: "c", url: "https://spam.example/z" },
  ];
  test("allow list keeps matches and subdomains", () => {
    expect(applyDomainFilter(sources, ["github.com"], undefined).map((s) => s.title)).toEqual(["a", "b"]);
  });
  test("blocked list drops matches", () => {
    expect(applyDomainFilter(sources, undefined, ["spam.example"]).map((s) => s.title)).toEqual(["a", "b"]);
  });
  test("drops unparseable urls", () => {
    expect(applyDomainFilter([{ title: "x", url: "not a url" }], undefined, undefined)).toEqual([]);
  });
});

describe("searchChain", () => {
  test("returns first usable response and records earlier failures", async () => {
    const bad = stubProvider("duckduckgo", new Error("boom"));
    const good = stubProvider("xai", { answer: "fresh", sources: [{ title: "t", url: "https://example.com" }] });
    const { response, failures } = await searchChain("q", { providers: [bad, good] });
    expect(response.provider).toBe("xai");
    expect(response.answer).toBe("fresh");
    expect(failures.map((f) => f.provider.id)).toEqual(["duckduckgo"]);
  });
  test("skips unavailable provider without recording a failure", async () => {
    const skipped = stubProvider("duckduckgo", { sources: [] }, false);
    const good = stubProvider("relaxed", { sources: [{ title: "t", url: "https://example.com" }] });
    const { response, failures } = await searchChain("q", { providers: [skipped, good] });
    expect(response.provider).toBe("relaxed");
    expect(failures).toEqual([]);
  });
  test("treats empty answer plus zero sources as unusable and moves on", async () => {
    const empty = stubProvider("duckduckgo", {});
    const good = stubProvider("relaxed", { sources: [{ title: "t", url: "https://example.com" }] });
    const { response, failures } = await searchChain("q", { providers: [empty, good] });
    expect(response.provider).toBe("relaxed");
    expect(failures.map((f) => f.provider.id)).toEqual(["duckduckgo"]);
  });
  test("returns none response with formatted failures when all fail", async () => {
    const a = stubProvider("duckduckgo", new Error("down"));
    const b = stubProvider("xai", new Error("no key"));
    const { response, failures } = await searchChain("q", { providers: [a, b] });
    expect(response.provider).toBe("none");
    expect(response.sources).toEqual([]);
    expect(formatAllFailures(failures)).toBe("All web search providers failed (duckduckgo: down; xai: no key)");
  });
  test("reports dropped constraints instead of dead search", async () => {
    const p = stubProvider("duckduckgo", {
      sources: [{ title: "a", url: "https://github.com/x" }],
    });
    const { response, dropped } = await searchChain("site:nowhere.example pi", { providers: [p] });
    expect(response.provider).toBe("duckduckgo");
    expect(response.sources.map((s) => s.title)).toEqual(["a"]);
    expect(dropped.join(" ")).toContain("site:nowhere.example");
  });
  test("falls back to relaxed provider without constraints before giving up", async () => {
    const p = stubProvider("relaxed", { sources: [{ title: "a", url: "https://example.com" }] });
    const { response } = await searchChain("site:nowhere.example pi", { providers: [p] });
    expect(response.provider).toBe("relaxed");
    expect(response.sources.map((s) => s.title)).toEqual(["a"]);
  });
  test("domain filter applies to chain results", async () => {
    const p = stubProvider("duckduckgo", {
      sources: [
        { title: "a", url: "https://github.com/x" },
        { title: "b", url: "https://spam.example/y" },
      ],
    });
    const { response } = await searchChain("q", { providers: [p], allowedDomains: ["github.com"] });
    expect(response.sources.map((s) => s.title)).toEqual(["a"]);
  });
});

describe("relaxQuery", () => {
  test("strips site operators and quotes", () => {
    expect(relaxQuery('site:github.com "pi hooks" extension')).toBe("pi hooks extension");
  });
  test("caps at eight words", () => {
    expect(relaxQuery("a b c d e f g h i j").split(" ")).toHaveLength(8);
  });
});

describe("mappings", () => {
  test("sources round trip to legacy results", () => {
    const response = { query: "q", provider: "duckduckgo" as const, answer: "abs", sources: [{ title: "t", url: "https://example.com", snippet: "s" }] };
    const legacy = toLegacyResults(response);
    expect(toSources(legacy)).toEqual(response.sources);
  });
  test("formatter renders answer then sources", () => {
    const text = formatSearchResponse({ query: "q", provider: "duckduckgo", answer: "abs", sources: [{ title: "t", url: "https://example.com" }] });
    expect(text).toBe("abs\n\n- t\n  https://example.com");
  });
  test("formatter falls back to no results", () => {
    expect(formatSearchResponse({ query: "q", provider: "none", sources: [] })).toBe("No results found.");
  });
});

describe("parseDuckDuckGoHtml", () => {
  test("unwraps result rows with snippets", () => {
    const html = '<a class="result__a" href="https://example.com/x">Example Title</a><a class="result__snippet" href="https://example.com/x">A snippet here</a>';
    expect(parseDuckDuckGoHtml(html)).toEqual([{ title: "Example Title", url: "https://example.com/x", snippet: "A snippet here" }]);
  });
  test("skips non http hrefs", () => {
    expect(parseDuckDuckGoHtml('<a class="result__a" href="//duckduckgo.com/l/?uddg=x">x</a>')).toEqual([]);
  });
});

describe("TavilyProvider", () => {
  test("unavailable without key", () => {
    expect(new TavilyProvider("").isAvailable()).toBe(false);
  });
  test("available with key", () => {
    expect(new TavilyProvider("k").isAvailable()).toBe(true);
  });
  test("throws when searching without key", async () => {
    await expect(new TavilyProvider("").search({ query: "x" })).rejects.toThrow("TAVILY_API_KEY");
  });
  test("chain tries tavily first when available", async () => {
    const t = new TavilyProvider("k");
    t.search = async (params) => ({ query: params.query, provider: "tavily", answer: "a", sources: [{ title: "t", url: "https://example.com" }] });
    const { response } = await searchChain("q", { providers: [t] });
    expect(response.provider).toBe("tavily");
    expect(response.answer).toBe("a");
  });
});

describe("chain recency and limit", () => {
  test("passes recency and limit to provider", async () => {
    let seen: any;
    const t = {
      id: "tavily",
      label: "t",
      isAvailable: () => true,
      search: async (params: any) => {
        seen = params;
        return { query: params.query, provider: "tavily", sources: [{ title: "t", url: "https://example.com" }] };
      },
    } as any;
    await searchChain("q", { providers: [t], recency: "week", limit: 3 });
    expect(seen.recency).toBe("week");
    expect(seen.limit).toBe(3);
  });
});
