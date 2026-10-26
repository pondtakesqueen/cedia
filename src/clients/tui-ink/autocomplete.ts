import { readFileSync, writeFileSync } from 'node:fs';

export type AutoItem = { value: string; name: string; description: string };

// Subsequence (fuzzy) match of q against name. Returns the matched indices,
// or null when q's characters do not all appear in order. Empty q matches all.
export function fuzzyMatch(name: string, q: string): number[] | null {
  if (!q) return [];
  const lower = name.toLowerCase();
  const hits: number[] = [];
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) { hits.push(i); qi++; }
  }
  return qi === q.length ? hits : null;
}

export type ScoredAutoItem = AutoItem & { hits: number[] };

// Prefix matches first, then by position of first hit, then by name.
// Build ranked dropdown items. Prefix matches first, then by position of the
// first hit, then by name. An optional frecency boost (0-900) moves often-
// or recently-picked items up without overtaking exact prefix matches.
export function buildAutoItems(
  commands: AutoItem[],
  skills: AutoItem[],
  q: string,
  frecency?: (value: string) => number,
): ScoredAutoItem[] {
  const query = q.toLowerCase();
  const scored = [...commands, ...skills].map((it) => {
    const plain = it.name.startsWith('/') ? it.name.slice(1) : it.name;
    const hits = fuzzyMatch(plain, query);
    if (!hits) return null;
    const prefix = plain.toLowerCase().startsWith(query);
    const bonus = frecency ? frecency(it.value) : 0;
    return { ...it, hits, score: (prefix ? 0 : 1000) + (hits[0] ?? 999) - bonus };
  }).filter((x): x is ScoredAutoItem & { score: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.map(({ score: _score, ...rest }) => rest);
}

// Frecency (frequency + recency) boost for ranking: values the user picks
// often, or picked recently, sort higher. Stored as plain JSON.
export type FrecencyMap = Record<string, { count: number; last: number }>;

export function loadFrecency(path: string): FrecencyMap {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FrecencyMap;
    if (raw && typeof raw === 'object') return raw;
  } catch {}
  return {};
}

export function recordPick(path: string, value: string, maxEntries = 500): void {
  try {
    let raw: FrecencyMap = {};
    try { raw = JSON.parse(readFileSync(path, 'utf8')) as FrecencyMap; } catch {}
    const prev = raw[value] ?? { count: 0, last: 0 };
    raw[value] = { count: prev.count + 1, last: Date.now() };
    const keys = Object.keys(raw).sort((a, b) => (raw[b]?.last ?? 0) - (raw[a]?.last ?? 0)).slice(0, maxEntries);
    const trimmed: FrecencyMap = {};
    for (const k of keys) trimmed[k] = raw[k]!;
    writeFileSync(path, JSON.stringify(trimmed));
  } catch {}
}

// Bonus subtracted from an item's score (prefix matches start at 0, others at 1000+).
export function frecencyBonus(map: FrecencyMap, value: string): number {
  const e = map[value];
  if (!e) return 0;
  const recent = Date.now() - e.last < 3600_000 ? 100 : 0;
  return Math.min(900, e.count * 100 + recent);
}
// Split a name into highlighted / plain runs for the dropdown.
export function highlightSpans(name: string, hits: number[]): { text: string; hit: boolean }[] {
  const hitSet = new Set(hits);
  const spans: { text: string; hit: boolean }[] = [];
  let cur = '';
  let curHit = false;
  const flush = () => { if (cur) spans.push({ text: cur, hit: curHit }); cur = ''; };
  for (let i = 0; i < name.length; i++) {
    const h = hitSet.has(i);
    if (h !== curHit) { flush(); curHit = h; }
    cur += name[i];
  }
  flush();
  return spans;
}

export function truncateDescription(desc: string, max: number): string {
  if (desc.length <= max) return desc;
  if (max <= 1) return '…';
  return desc.slice(0, max - 1) + '…';
}

// Hard cap for huge pasted text: head + hidden-line count + tail, so one
// giant message never makes every frame rewrap megabytes.
export function truncateLongText(text: string, max = 10000, head = 2500, tail = 2500): string {
  if (text.length <= max) return text;
  const headPart = text.slice(0, head);
  const tailPart = text.slice(-tail);
  const hidden = (text.match(/\n/g) || []).length - (tailPart.match(/\n/g) || []).length;
  return `${headPart}\n… +${Math.max(0, hidden)} lines …\n${tailPart}`;
}

// Estimated wrapped-row count for virtualized windowing (like cc's height cache,
// but computed instead of measured: each visual line costs one row).
export function estimateLines(text: string, width: number): number {
  const w = Math.max(10, width);
  let n = 0;
  for (const ln of text.split('\n')) n += Math.max(1, Math.ceil(ln.length / w));
  return n;
}
