import { URL } from "node:url";
import { applyQueryConstraints, formatScraperQuery, parseSearchQuery } from "./websearch-query.ts";
import { DuckDuckGoProvider, RelaxedQueryProvider, XaiProvider, type SearchProvider } from "./websearch-providers.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface LegacySearchResponse {
  query: string;
  results: SearchResult[];
  abstract?: string;
}

export type SearchProviderId = "duckduckgo" | "xai" | "relaxed" | "none";

export interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchCitation {
  url: string;
  title: string;
  citedText?: string;
}

export interface SearchResponse {
  query: string;
  provider: SearchProviderId;
  answer?: string;
  sources: SearchSource[];
  citations?: SearchCitation[];
}

export interface SearchParams {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal?: AbortSignal;
  parsedQuery?: ReturnType<typeof parseSearchQuery>;
}

export interface ProviderFailure {
  provider: { id: string; label: string };
  error: unknown;
}

export const DEFAULT_PROVIDERS: readonly SearchProvider[] = [new DuckDuckGoProvider(), new XaiProvider(), new RelaxedQueryProvider()];

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatProviderFailure(f: ProviderFailure): string {
  return `${f.provider.id}: ${failureMessage(f.error)}`;
}

export function formatAllFailures(failures: readonly ProviderFailure[]): string {
  if (failures.length === 0) return "no providers attempted";
  if (failures.length === 1) return formatProviderFailure(failures[0]);
  return `All web search providers failed (${failures.map(formatProviderFailure).join("; ")})`;
}

export function extractHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function normalizeDomains(input: readonly string[] | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const raw of input) {
    const host = raw.trim().toLowerCase();
    if (!host || out.includes(host)) continue;
    out.push(host);
  }
  return out;
}

function hostMatches(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export function applyDomainFilter(
  sources: readonly SearchSource[],
  allowed: readonly string[] | undefined,
  blocked: readonly string[] | undefined,
): SearchSource[] {
  const allow = normalizeDomains(allowed);
  const block = normalizeDomains(blocked).filter((d) => !allow.some((a) => d === a || d.endsWith(`.${a}`) || a.endsWith(`.${d}`)));
  return sources.filter((s) => {
    const host = extractHost(s.url);
    if (!host) return false;
    if (allow.length > 0) return hostMatches(host, allow);
    return !hostMatches(host, block);
  });
}

export function toSources(results: readonly SearchResult[]): SearchSource[] {
  return results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet || undefined }));
}

export function toLegacyResults(response: SearchResponse): SearchResult[] {
  return response.sources.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet ?? s.title }));
}

function isUsable(response: SearchResponse): boolean {
  return Boolean(response.answer?.trim()) || response.sources.length > 0;
}

export async function searchChain(
  query: string,
  opts?: {
    allowedDomains?: readonly string[];
    blockedDomains?: readonly string[];
    signal?: AbortSignal;
    providers?: readonly SearchProvider[];
  },
): Promise<{ response: SearchResponse; failures: ProviderFailure[]; dropped: string[] }> {
  const allowed = normalizeDomains(opts?.allowedDomains);
  const blocked = normalizeDomains(opts?.blockedDomains);
  const parsed = parseSearchQuery(query);
  const providers = opts?.providers ?? DEFAULT_PROVIDERS;
  const failures: ProviderFailure[] = [];
  for (const provider of providers) {
    let available = false;
    try {
      available = await provider.isAvailable();
    } catch {
      available = false;
    }
    if (!available) continue;
    let response: SearchResponse;
    try {
      const engineQuery = provider.id === "duckduckgo" || provider.id === "relaxed" ? formatScraperQuery(query, parsed) : query;
      response = await provider.search({ query: engineQuery, allowedDomains: allowed, blockedDomains: blocked, signal: opts?.signal, parsedQuery: parsed });
    } catch (error) {
      failures.push({ provider: { id: provider.id, label: provider.label }, error });
      continue;
    }
    const mapped = response.sources.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet }));
    const constrained = parsed.hasConstraints ? applyQueryConstraints(mapped, parsed) : { sources: mapped, dropped: [] as string[] };
    const filtered: SearchSource[] = applyDomainFilter(constrained.sources, allowed, blocked);
    const usable: SearchResponse = { ...response, query, sources: filtered };
    if (isUsable(usable)) return { response: usable, failures, dropped: constrained.dropped };
    if (provider.id === "relaxed") {
      const fallback: SearchResponse = { ...response, query, sources: applyDomainFilter(mapped, allowed, blocked) };
      if (isUsable(fallback)) return { response: fallback, failures, dropped: constrained.dropped };
    }
    failures.push({
      provider: { id: provider.id, label: provider.label },
      error: new Error("no usable results"),
    });
  }
  return { response: { query, provider: "none", sources: [] }, failures, dropped: [] };
}

export async function searchWeb(query: string): Promise<LegacySearchResponse> {
  const { response } = await searchChain(query);
  return { query, results: toLegacyResults(response), abstract: response.answer };
}

export function formatSearchResponse(response: SearchResponse): string {
  const lines: string[] = [];
  if (response.answer) lines.push(response.answer, "");
  for (const r of response.sources) {
    lines.push(`- ${r.title}`);
    lines.push(`  ${r.url}`);
    if (r.snippet && r.snippet !== r.title) lines.push(`  ${r.snippet.slice(0, 200)}`);
  }
  if (lines.length === 0) lines.push("No results found.");
  return lines.join("\n");
}
