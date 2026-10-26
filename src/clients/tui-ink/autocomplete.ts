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
export function buildAutoItems(
  commands: AutoItem[],
  skills: AutoItem[],
  q: string,
): ScoredAutoItem[] {
  const query = q.toLowerCase();
  const scored = [...commands, ...skills].map((it) => {
    const plain = it.name.startsWith('/') ? it.name.slice(1) : it.name;
    const hits = fuzzyMatch(plain, query);
    if (!hits) return null;
    const prefix = plain.toLowerCase().startsWith(query);
    return { ...it, hits, score: (prefix ? 0 : 1000) + (hits[0] ?? 999) };
  }).filter((x): x is ScoredAutoItem & { score: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.map(({ score: _score, ...rest }) => rest);
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
