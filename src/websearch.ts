const MAX_RESULTS = 10;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  abstract?: string;
}

export async function searchWeb(query: string): Promise<SearchResponse> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "cedia/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;

    const results: SearchResult[] = [];
    // Related topics
    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics) {
        if (topic.Text && topic.FirstURL) {
          results.push({ title: topic.Text.slice(0, 100), url: topic.FirstURL, snippet: topic.Text });
          if (results.length >= MAX_RESULTS) break;
        }
        // Nested topics
        if (Array.isArray(topic.Topics)) {
          for (const sub of topic.Topics) {
            if (sub.Text && sub.FirstURL) {
              results.push({ title: sub.Text.slice(0, 100), url: sub.FirstURL, snippet: sub.Text });
              if (results.length >= MAX_RESULTS) break;
            }
          }
        }
      }
    }

    return {
      query,
      results: results.slice(0, MAX_RESULTS),
      abstract: data.Abstract || undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}