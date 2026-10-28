/** Pure vim text-object ranges for the ink prompt (end exclusive). */

export type TextObjectKind = 'i' | 'a';

const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
const isSpace = (ch: string) => /\s/.test(ch);

const PAIRS: Record<string, { open: string; close: string }> = {
  '(': { open: '(', close: ')' },
  ')': { open: '(', close: ')' },
  b: { open: '(', close: ')' },
  '[': { open: '[', close: ']' },
  ']': { open: '[', close: ']' },
  '{': { open: '{', close: '}' },
  '}': { open: '{', close: '}' },
  B: { open: '{', close: '}' },
  '<': { open: '<', close: '>' },
  '>': { open: '<', close: '>' },
  t: { open: '<', close: '>' },
};

const QUOTES = new Set(['"', "'", '`']);

function wordSpan(text: string, cursor: number, wide: boolean): { lo: number; hi: number } | null {
  if (!text.length) return null;
  const c = Math.max(0, Math.min(cursor, text.length - (text.length ? 1 : 0)));
  const ok = wide ? (ch: string) => !isSpace(ch) : isWord;
  let i = c;
  if (!ok(text[i]!) && !wide) {
    // On non-word: treat contiguous non-word/non-space as a "word", else spaces.
    if (isSpace(text[i]!)) {
      let lo = i;
      while (lo > 0 && isSpace(text[lo - 1]!)) lo--;
      let hi = i + 1;
      while (hi < text.length && isSpace(text[hi]!)) hi++;
      return { lo, hi };
    }
    let lo = i;
    while (lo > 0 && !isWord(text[lo - 1]!) && !isSpace(text[lo - 1]!)) lo--;
    let hi = i + 1;
    while (hi < text.length && !isWord(text[hi]!) && !isSpace(text[hi]!)) hi++;
    return { lo, hi };
  }
  if (!ok(text[i]!)) {
    // wide WORD on whitespace: select the whitespace run
    let lo = i;
    while (lo > 0 && isSpace(text[lo - 1]!)) lo--;
    let hi = i + 1;
    while (hi < text.length && isSpace(text[hi]!)) hi++;
    return { lo, hi };
  }
  let lo = i;
  while (lo > 0 && ok(text[lo - 1]!)) lo--;
  let hi = i + 1;
  while (hi < text.length && ok(text[hi]!)) hi++;
  return { lo, hi };
}

function aroundWord(text: string, inner: { lo: number; hi: number }): { lo: number; hi: number } {
  let { lo, hi } = inner;
  const trailStart = hi;
  while (hi < text.length && isSpace(text[hi]!)) hi++;
  if (hi > trailStart) return { lo, hi };
  while (lo > 0 && isSpace(text[lo - 1]!)) lo--;
  return { lo, hi: inner.hi };
}

function quoteSpan(text: string, cursor: number, quote: string, kind: TextObjectKind): { lo: number; hi: number } | null {
  // Scan left for an opening quote whose matching closer is at/after the cursor.
  for (let i = Math.min(cursor, Math.max(0, text.length - 1)); i >= 0; i--) {
    if (text[i] !== quote) continue;
    let close = -1;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === quote) { close = j; break; }
    }
    if (close >= 0 && close >= cursor) {
      return kind === 'i' ? { lo: i + 1, hi: close } : { lo: i, hi: close + 1 };
    }
  }
  return null;
}

function pairSpan(text: string, cursor: number, openCh: string, closeCh: string, kind: TextObjectKind): { lo: number; hi: number } | null {
  // Walk left for the open that matches nesting at cursor.
  let depth = 0;
  let open = -1;
  const start = Math.min(cursor, Math.max(0, text.length - 1));
  for (let i = start; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === closeCh) depth++;
    else if (ch === openCh) {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  if (open < 0) return null;
  depth = 0;
  let close = -1;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      if (depth === 0) { close = i; break; }
      depth--;
    }
  }
  if (close < 0) return null;
  if (cursor < open || cursor > close) return null;
  return kind === 'i' ? { lo: open + 1, hi: close } : { lo: open, hi: close + 1 };
}

/** Resolve `i`/`a` + object char at cursor. Returns end-exclusive range or null. */
export function textObjectRange(
  text: string,
  cursor: number,
  kind: TextObjectKind,
  object: string,
): { lo: number; hi: number } | null {
  if (!object) return null;
  if (object === 'w' || object === 'W') {
    const inner = wordSpan(text, cursor, object === 'W');
    if (!inner) return null;
    return kind === 'i' ? inner : aroundWord(text, inner);
  }
  if (QUOTES.has(object)) return quoteSpan(text, cursor, object, kind);
  const pair = PAIRS[object];
  if (pair) return pairSpan(text, cursor, pair.open, pair.close, kind);
  return null;
}

export function isTextObjectChar(ch: string): boolean {
  return ch === 'w' || ch === 'W' || QUOTES.has(ch) || ch in PAIRS;
}
