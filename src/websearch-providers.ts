import type { SearchParams, SearchResponse } from "./websearch.ts";
import { formatScraperQuery, type QuerySyntax } from "./websearch-query.ts";

export interface SearchProvider {
  readonly id: "tavily" | "duckduckgo" | "xai" | "relaxed";
  readonly label: string;
  isAvailable(): boolean | Promise<boolean>;
  search(params: SearchParams): Promise<SearchResponse>;
}

const TAVILY_URL = "https://api.tavily.com/search";
const TAVILY_TIMEOUT_MS = 30000;
const TAVILY_MAX_RESULTS = 10;
const XAI_URL = "https://api.x.ai/v1/responses";
const XAI_MODEL = "grok-4-1-fast-non-reasoning";
const XAI_TIMEOUT_MS = 30000;
const MAX_RESULTS = 10;
const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";
const DUCKDUCKGO_TIMEOUT_MS = 15000;
const DUCKDUCKGO_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
export class DuckDuckGoProvider implements SearchProvider {
  readonly id = "duckduckgo" as const;
  readonly label = "DuckDuckGo";

  isAvailable(): boolean {
    return true;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DUCKDUCKGO_TIMEOUT_MS);
    try {
      const syntax: QuerySyntax = { phrases: true, negation: true, or: true, site: true, inUrl: true, inTitle: true, inText: true, filetype: true, dateRange: false };
      const engineQuery = formatScraperQuery(params.query, params.parsedQuery, syntax);
      const body = new URLSearchParams({ q: engineQuery, kl: "us-en", b: "" });
      const res = await fetch(DUCKDUCKGO_URL, {
        method: "POST",
        signal: params.signal ?? controller.signal,
        headers: { "User-Agent": DUCKDUCKGO_UA, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://html.duckduckgo.com/" },
        body: body.toString(),
      });
      if (!res.ok) throw new Error(`DuckDuckGo HTML error (${res.status})`);
      const html = await res.text();
      if (html.includes("anomaly-modal") || html.includes("anomaly.js")) {
        throw new Error("DuckDuckGo blocked the request with a bot-detection challenge; results unavailable from this network");
      }
      return { query: params.query, provider: "duckduckgo", sources: parseDuckDuckGoHtml(html) };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface TavilyResultItem {
  title?: string;
  url?: string;
  content?: string;
}

/** Keyed provider. No key means unavailable, skipped by the chain, never an error. */
export class TavilyProvider implements SearchProvider {
  readonly id = "tavily" as const;
  readonly label = "Tavily";

  private apiKey: string;

  constructor(apiKey: string | undefined = process.env.TAVILY_API_KEY) {
    this.apiKey = apiKey ?? "";
  }

  isAvailable(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    if (!this.apiKey.trim()) throw new Error("TAVILY_API_KEY is not set");
    const parsed = params.parsedQuery;
    const includeDomains = [...new Set([...(params.allowedDomains ?? []), ...(parsed?.sites ?? [])])].slice(0, 10);
    const excludeDomains = [...new Set([...(params.blockedDomains ?? []), ...(parsed?.excludedSites ?? [])])].slice(0, 10);
    const limit = params.limit !== undefined ? Math.min(Math.max(Math.floor(params.limit), 1), TAVILY_MAX_RESULTS) : TAVILY_MAX_RESULTS;
    const body: Record<string, unknown> = {
      query: params.query,
      search_depth: "basic",
      max_results: limit,
      include_answer: "advanced",
      include_raw_content: false,
    };
    if (includeDomains.length > 0) body.include_domains = includeDomains;
    if (excludeDomains.length > 0) body.exclude_domains = excludeDomains;
    if (parsed?.after) body.start_date = parsed.after;
    if (parsed?.before) body.end_date = parsed.before;
    if (params.recency && !parsed?.after && !parsed?.before) body.time_range = params.recency;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
    try {
      const res = await fetch(TAVILY_URL, {
        method: "POST",
        signal: params.signal ?? controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401 || res.status === 403) throw new Error(`Tavily auth failed (${res.status}); check TAVILY_API_KEY`);
      if (!res.ok) throw new Error(`Tavily error (${res.status})`);
      const data = (await res.json()) as { answer?: string; results?: TavilyResultItem[] };
      const sources: SearchResponse["sources"] = [];
      for (const r of data.results ?? []) {
        if (sources.length >= TAVILY_MAX_RESULTS) break;
        if (!r.url || !/^https?:\/\//.test(r.url)) continue;
        const title = (r.title ?? r.url).slice(0, 100);
        sources.push({ title, url: r.url, snippet: r.content?.slice(0, 300) });
      }
      return {
        query: params.query,
        provider: "tavily",
        answer: data.answer?.trim() || undefined,
        sources,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseDuckDuckGoHtml(html: string): SearchResponse["sources"] {
  const sources: SearchResponse["sources"] = [];
  const rowPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(html)) !== null && sources.length < MAX_RESULTS) {
    const url = decodeHtmlEntities(match[1].trim());
    const title = decodeHtmlEntities(stripTags(match[2])).trim().slice(0, 100);
    const snippet = match[3] ? decodeHtmlEntities(stripTags(match[3])).trim() : undefined;
    if (!title || !/^https?:\/\//.test(url)) continue;
    sources.push({ title, url, snippet: snippet && snippet !== title ? snippet : undefined });
  }
  return sources;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ");
}

/** Second attempt with the same engine and a relaxed query form. */
export class RelaxedQueryProvider implements SearchProvider {
  readonly id = "relaxed" as const;
  readonly label = "DuckDuckGo (relaxed)";
  private inner: SearchProvider;

  constructor(inner: SearchProvider = new DuckDuckGoProvider()) {
    this.inner = inner;
  }

  isAvailable(): boolean {
    return true;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const relaxed = relaxQuery(params.query);
    if (relaxed === params.query) {
      return { query: params.query, provider: "relaxed", sources: [] };
    }
    const inner = await this.inner.search({ ...params, query: relaxed });
    return { ...inner, query: params.query, provider: "relaxed" };
  }
}

export function relaxQuery(query: string): string {
  const stripped = query
    .replace(/\bsite:[^\s]+/gi, " ")
    .replace(/["']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.split(" ").slice(0, 8).join(" ");
}

interface XaiOutputItem {
  type?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }> }>;
  annotations?: Array<{ type?: string; url?: string; title?: string }>;
}

export class XaiProvider implements SearchProvider {
  readonly id = "xai" as const;
  readonly label = "xAI";
  private apiKey: string;

  constructor(apiKey: string | undefined = process.env.XAI_API_KEY) {
    this.apiKey = apiKey ?? "";
  }

  isAvailable(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    if (!this.apiKey.trim()) throw new Error("XAI_API_KEY is not set");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), XAI_TIMEOUT_MS);
    try {
      const res = await fetch(XAI_URL, {
        method: "POST",
        signal: params.signal ?? controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: XAI_MODEL,
          input: [
            { role: "system", content: "Answer the question using live web and X search. Cite sources with URLs." },
            { role: "user", content: params.query },
          ],
          search_parameters: { mode: "on", return_citations: true, max_search_results: 10 },
        }),
      });
      const data = (await res.json()) as { output?: XaiOutputItem[]; output_text?: string };
      const texts: string[] = [];
      for (const item of data.output ?? []) {
        const blocks = item.content ?? (item.text ? [{ text: item.text }] : []);
        for (const block of blocks) {
          if (typeof block.text === "string" && block.text.length > 0) texts.push(block.text);
        }
      }
      const joined = texts.join("\n").trim();
      const answer = data.output_text ?? (joined.length > 0 ? joined : undefined);

      const sources: SearchResponse["sources"] = [];
      const citations: SearchResponse["citations"] = [];
      for (const item of data.output ?? []) {
        for (const block of item.content ?? []) {
          for (const a of block.annotations ?? []) {
            if (a.type === "url_citation" && a.url) {
              citations.push({ url: a.url, title: a.title ?? a.url });
            }
          }
        }
        for (const a of item.annotations ?? []) {
          if (a.type === "url_citation" && a.url) {
            citations.push({ url: a.url, title: a.title ?? a.url });
          }
        }
      }
      for (const c of citations) {
        if (sources.length >= MAX_RESULTS) break;
        if (!sources.some((s) => s.url === c.url)) {
          sources.push({ title: c.title, url: c.url });
        }
      }

      return { query: params.query, provider: "xai", answer, sources, citations: citations.length ? citations : undefined };
    } finally {
      clearTimeout(timer);
    }
  }
}
