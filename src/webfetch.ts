import { URL } from "node:url";

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isDenied(url: string, denyDomains: string[]): boolean {
  const domain = extractDomain(url);
  return denyDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const TIMEOUT_MS = 30000;

export interface FetchResult {
  url: string;
  title?: string;
  content: string;
  contentType: string;
}

export async function fetchUrl(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "cedia/1.0", Accept: "text/html,application/xhtml+xml,text/plain,*/*" },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const contentType = res.headers.get("content-type") ?? "text/plain";
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      throw new Error(`Response too large: ${buffer.byteLength} bytes (max ${MAX_BYTES})`);
    }
    const text = new TextDecoder().decode(buffer);

    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      const title = extractTitle(text);
      const markdown = htmlToMarkdown(text);
      return { url: res.url, title, content: markdown, contentType };
    }
    return { url: res.url, content: text, contentType };
  } finally {
    clearTimeout(timer);
  }
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  return m[1].replace(/\s+/g, " ").trim();
}

export function htmlToMarkdown(html: string): string {
  // Remove script/style/noscript blocks
  let text = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // Convert headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    const prefix = "#".repeat(parseInt(level, 10));
    return `\n${prefix} ${stripTags(content).trim()}\n`;
  });
  // Convert links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const label = stripTags(content).trim();
    return `[${label}](${href})`;
  });
  // Convert code blocks
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
    const code = stripTags(content).trim();
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });
  // Convert inline code
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, content) => `\`${stripTags(content).trim()}\``);
  // Convert bold
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, content) => `**${stripTags(content).trim()}**`);
  // Convert italic
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, content) => `*${stripTags(content).trim()}*`);
  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => `- ${stripTags(content).trim()}\n`);
  // Convert paragraphs
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => `\n${stripTags(content).trim()}\n`);
  // Convert br
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags
  text = stripTags(text);
  // Decode entities
  text = decodeEntities(text);
  // Collapse whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  return text.trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}