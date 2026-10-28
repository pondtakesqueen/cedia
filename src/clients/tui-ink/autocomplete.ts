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

// Prefix matches first, then by position of the first hit, then by name. An
// optional boost (0-900, from picks.ts) moves the person's usual picks up
// without lifting a fuzzy match over a prefix match.
export function buildAutoItems(
  commands: AutoItem[],
  skills: AutoItem[],
  q: string,
  boost?: (value: string) => number,
): ScoredAutoItem[] {
  const query = q.toLowerCase();
  const scored = [...commands, ...skills].map((it) => {
    const plain = it.name.startsWith('/') ? it.name.slice(1) : it.name;
    const hits = fuzzyMatch(plain, query);
    if (!hits) return null;
    const prefix = plain.toLowerCase().startsWith(query);
    return { ...it, hits, score: (prefix ? 0 : 1000) + (hits[0] ?? 999) - (boost?.(it.value) ?? 0) };
  }).filter((x): x is ScoredAutoItem & { score: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.map(({ score: _score, ...rest }) => rest);
}

// Split a name into highlighted / plain runs for the dropdown.
export type TextRun = { text: string; hit: boolean };

export function highlightQuery(text: string, query: string): TextRun[] {
  if (!query) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return [{ text, hit: false }];
  const runs: TextRun[] = [];
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(needle, i);
    if (at < 0) {
      const rest = text.slice(i);
      if (rest) runs.push({ text: rest, hit: false });
      break;
    }
    if (at > i) runs.push({ text: text.slice(i, at), hit: false });
    const hit = text.slice(at, at + needle.length);
    const prev = runs[runs.length - 1];
    if (prev?.hit) prev.text += hit;
    else if (hit) runs.push({ text: hit, hit: true });
    i = at + needle.length;
  }
  return runs.length ? runs : [{ text, hit: false }];
}

export type PaintMark = { text: string; hit: boolean; selected: boolean };

export function paintRuns(
  text: string,
  opts: { query?: string; selection?: { start: number; end: number } },
): PaintMark[] {
  const base = highlightQuery(text, opts.query?.trim() ?? '');
  const sel = opts.selection;
  const hasSel = !!sel && sel.end > sel.start;
  const out: PaintMark[] = [];
  let pos = 0;
  for (const run of base) {
    if (!hasSel || !sel) {
      out.push({ text: run.text, hit: run.hit, selected: false });
      pos += run.text.length;
      continue;
    }
    let i = 0;
    while (i < run.text.length) {
      const abs = pos + i;
      const selected = abs >= sel.start && abs < sel.end;
      let j = i + 1;
      while (j < run.text.length) {
        const a = pos + j;
        if ((a >= sel.start && a < sel.end) !== selected) break;
        j++;
      }
      out.push({ text: run.text.slice(i, j), hit: run.hit, selected });
      i = j;
    }
    pos += run.text.length;
  }
  const merged: PaintMark[] = [];
  for (const mark of out) {
    if (!mark.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.hit === mark.hit && prev.selected === mark.selected) prev.text += mark.text;
    else merged.push({ ...mark });
  }
  return merged.length ? merged : [{ text, hit: false, selected: false }];
}

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

export function offsetAt(text: string, width: number, rowInSpan: number, col: number): number {
  const w = Math.max(10, width);
  const safeRow = Math.max(0, rowInSpan);
  const safeCol = Math.max(0, col);
  let seen = 0;
  let pos = 0;
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li] ?? '';
    const rows = Math.max(1, Math.ceil(ln.length / w));
    if (safeRow < seen + rows) {
      const within = safeRow - seen;
      const rowStart = within * w;
      const rowLen = Math.max(0, Math.min(w, ln.length - rowStart));
      return pos + rowStart + Math.min(safeCol, rowLen);
    }
    seen += rows;
    pos += ln.length + (li < lines.length - 1 ? 1 : 0);
  }
  return text.length;
}
