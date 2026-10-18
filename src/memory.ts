import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MEMORY_DIR = join(homedir(), ".cedia", "memory");

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function memoryWrite(key: string, content: string): void {
  ensureDir();
  writeFileSync(join(MEMORY_DIR, `${safeKey(key)}.md`), content, "utf8");
}

export function memoryRead(key: string): string | undefined {
  const path = join(MEMORY_DIR, `${safeKey(key)}.md`);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

export function memoryList(): string[] {
  ensureDir();
  return readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

export function memoryDelete(key: string): boolean {
  const path = join(MEMORY_DIR, `${safeKey(key)}.md`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export interface MemorySearchResult {
  key: string;
  snippet: string;
}

export function memorySearch(query: string): MemorySearchResult[] {
  ensureDir();
  const results: MemorySearchResult[] = [];
  const lower = query.toLowerCase();
  for (const key of memoryList()) {
    const content = memoryRead(key);
    if (!content) continue;
    const idx = content.toLowerCase().indexOf(lower);
    if (idx !== -1) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(content.length, idx + query.length + 60);
      const snippet = (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
      results.push({ key, snippet });
    }
  }
  return results;
}