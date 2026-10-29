import { highlight } from './markdown.tsx';
import type { RowLine, RowSpan } from './rows.ts';

// An edit's diff as transcript rows: the changed lines with up to two unchanged ones around them, code colors from
// the markdown highlighter, and a stronger band on the characters that changed. A wide screen shows the old and
// the new side by side when every line fits its half; otherwise one column, removed lines over added ones.
//
//   11    export function f() {       │ 11    export function f() {
//   12 -    return a - b;              │ 12 +    return a + b;
//   13    }                           │ 13    }

export type DiffSign = ' ' | '-' | '+';
/** One line of a hunk; `old` and `new` are its numbers on each side, when known. */
export type DiffLine = { sign: DiffSign; old?: number; new?: number; text: string };
export type Hunk = DiffLine[];

// Unchanged lines kept on each side of a change.
export const CONTEXT = 2;
// The narrowest row that may split, and the rows a diff takes before the rest is a count.
export const SPLIT_MIN_WIDTH = 120;
export const MAX_DIFF_ROWS = 12;
const SEP = ' │ ';

/**
 * The hunk of one replacement: the lines old and new share at their start and end are context (the last
 * CONTEXT of the start, the first CONTEXT of the end); between them, lines both sides keep in the same order stay
 * as context too, and the rest is removed and added. `from` is the line the replaced text starts on, or
 * undefined when it is not known.
 */
export function hunkOf(oldText: string, newText: string, from: number | undefined): { hunk: Hunk; added: number; removed: number } {
  const o = oldText.split('\n');
  const n = newText.split('\n');
  let pre = 0;
  while (pre < o.length && pre < n.length && o[pre] === n[pre]) pre++;
  let post = 0;
  while (post < o.length - pre && post < n.length - pre && o[o.length - 1 - post] === n[n.length - 1 - post]) post++;
  const at = (k: number) => (from === undefined ? undefined : from + k);
  const hunk: Hunk = [];
  for (let k = Math.max(0, pre - CONTEXT); k < pre; k++) hunk.push({ sign: ' ', old: at(k), new: at(k), text: o[k]! });
  let i = pre;
  let j = pre;
  let added = 0;
  let removed = 0;
  for (const step of lineSteps(o.slice(pre, o.length - post), n.slice(pre, n.length - post))) {
    if (step === ' ') hunk.push({ sign: ' ', old: at(i), new: at(j), text: o[i++]! }), j++;
    else if (step === '-') hunk.push({ sign: '-', old: at(i), text: o[i++]! }), removed++;
    else hunk.push({ sign: '+', new: at(j), text: n[j++]! }), added++;
  }
  for (let k = 0; k < Math.min(CONTEXT, post); k++) hunk.push({ sign: ' ', old: at(i + k), new: at(j + k), text: o[i + k]! });
  return { hunk, added, removed };
}

// How to turn a into b a line at a time, keeping the longest run of lines both have in order (an LCS table, as
// diff does). Past MAX_LCS cells it is every line out, then every line in.
const MAX_LCS = 40_000;
function lineSteps(a: string[], b: string[]): DiffSign[] {
  if (a.length * b.length > MAX_LCS) return [...a.map(() => '-' as const), ...b.map(() => '+' as const)];
  const w = b.length + 1;
  const len = new Uint16Array((a.length + 1) * w);
  for (let x = a.length - 1; x >= 0; x--) {
    for (let y = b.length - 1; y >= 0; y--) {
      len[x * w + y] = a[x] === b[y] ? len[(x + 1) * w + y + 1]! + 1 : Math.max(len[(x + 1) * w + y]!, len[x * w + y + 1]!);
    }
  }
  const steps: DiffSign[] = [];
  let x = 0;
  let y = 0;
  while (x < a.length || y < b.length) {
    if (x < a.length && y < b.length && a[x] === b[y]) { steps.push(' '); x++; y++; }
    // Removed lines go before added ones where either order keeps as much.
    else if (x < a.length && (y >= b.length || len[(x + 1) * w + y]! >= len[x * w + y + 1]!)) { steps.push('-'); x++; }
    else { steps.push('+'); y++; }
  }
  return steps;
}

/** The changed run of a removed line and the added line that replaces it, without the space at its edges. */
export function wordRun(a: string, b: string): [[number, number], [number, number]] | undefined {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  // A line changed from end to end gets its band alone; nothing in it stands out.
  if (p === 0 && q === 0) return undefined;
  const trim = (s: string, from: number, to: number): [number, number] => {
    while (from < to && s[from] === ' ') from++;
    while (to > from && s[to - 1] === ' ') to--;
    return [from, to];
  };
  return [trim(a, p, a.length - q), trim(b, p, b.length - q)];
}

const EXT_LANG: Record<string, string> = { py: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', yml: 'yaml', yaml: 'yaml', toml: 'toml', rb: 'rb' };
/** The highlighter's language for a path: only whether `#` starts a comment depends on it. */
export const langOf = (path: string): string => EXT_LANG[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'ts';

const expand = (s: string) => s.replace(/\t/g, '  ');

// One side's code: colored spans cut at the changed run's edges, clipped to `width`, and with `pad` filled out to
// it, so the next column starts where it should and a band runs to the column's edge.
function codeSpans(text: string, lang: string, width: number, band: RowSpan['bg'], word: [number, number] | undefined, wordBg: RowSpan['bg'], pad: boolean): RowSpan[] {
  const out: RowSpan[] = [];
  const clipped = text.length > width;
  const limit = clipped ? Math.max(0, width - 1) : text.length;
  let at = 0;
  for (const sp of highlight(text, lang)) {
    let s = sp.text;
    while (s.length && at < limit) {
      let cut = Math.min(s.length, limit - at);
      if (word) {
        if (at < word[0] && at + cut > word[0]) cut = word[0] - at;
        else if (at < word[1] && at + cut > word[1]) cut = word[1] - at;
      }
      const inWord = word !== undefined && at >= word[0] && at < word[1];
      const bg = inWord ? wordBg : band;
      out.push({ text: s.slice(0, cut), style: sp.style, ...(bg ? { bg } : {}) });
      at += cut;
      s = s.slice(cut);
    }
  }
  if (clipped) out.push({ text: '…', style: 'faint', ...(band ? { bg: band } : {}) });
  else if (pad && width > text.length) out.push({ text: ' '.repeat(width - text.length), style: 'text', ...(band ? { bg: band } : {}) });
  return out;
}

const bandOf = (sign: DiffSign): 'add' | 'del' | undefined => (sign === '-' ? 'del' : sign === '+' ? 'add' : undefined);
const wordOf = (sign: DiffSign): RowSpan['bg'] => (sign === '-' ? 'delWord' : 'addWord');
const signStyle = (sign: DiffSign) => (sign === '-' ? 'err' : sign === '+' ? 'ok' : 'faint') as RowSpan['style'];

// A hunk as runs: a context line alone, or a block of removed lines and the added lines after them.
type Block = { ctx?: DiffLine; del: DiffLine[]; add: DiffLine[] };
function blocks(hunk: Hunk): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < hunk.length; ) {
    if (hunk[i]!.sign === ' ') { out.push({ ctx: hunk[i++], del: [], add: [] }); continue; }
    const b: Block = { del: [], add: [] };
    while (i < hunk.length && hunk[i]!.sign === '-') b.del.push(hunk[i++]!);
    while (i < hunk.length && hunk[i]!.sign === '+') b.add.push(hunk[i++]!);
    out.push(b);
  }
  return out;
}

export type DiffLayout = 'split' | 'unified';

/**
 * Rows for an edit's hunks within `width` columns, after `indent` spaces: side by side when the width allows
 * and no line would be cut, else one column. At most `max` rows; the changed lines past them are `hidden`.
 */
export function diffRows(hunks: Hunk[], width: number, lang: string, indent: number, max = MAX_DIFF_ROWS): { lines: RowLine[]; hidden: number; layout: DiffLayout } {
  const nums = hunks.flat().flatMap((l) => [l.old, l.new]).filter((n): n is number => n !== undefined);
  const nw = nums.length ? String(Math.max(...nums)).length : 0;
  // Number, a space, the sign and a space before the code.
  const gutter = (nw ? nw + 1 : 0) + 2;
  const half = Math.floor((width - indent - SEP.length) / 2);
  const longest = Math.max(0, ...hunks.flat().map((l) => expand(l.text).length));
  const layout: DiffLayout = width >= SPLIT_MIN_WIDTH && longest <= half - gutter ? 'split' : 'unified';
  const pad: RowSpan = { text: ' '.repeat(indent), style: 'text' };
  const head = (l: DiffLine, n: number | undefined): RowSpan[] => {
    const bg = bandOf(l.sign);
    return [
      ...(nw ? [{ text: `${String(n ?? '').padStart(nw)} `, style: signStyle(l.sign), ...(bg ? { bg } : {}) }] : []),
      { text: l.sign === ' ' ? '  ' : `${l.sign} `, style: signStyle(l.sign), ...(bg ? { bg } : {}) },
    ];
  };
  const rows: { line: RowLine; changed: number }[] = [];
  const unified = (l: DiffLine, word: [number, number] | undefined) => {
    const bg = bandOf(l.sign);
    rows.push({
      line: { spans: [pad, ...head(l, l.sign === '+' ? l.new : l.old), ...codeSpans(expand(l.text), lang, width - indent - gutter, bg, word, wordOf(l.sign), false)], ...(bg ? { band: bg } : {}) },
      changed: l.sign === ' ' ? 0 : 1,
    });
  };
  const side = (l: DiffLine | undefined, which: 'old' | 'new', word: [number, number] | undefined, last: boolean): RowSpan[] => {
    if (!l) return last ? [] : [{ text: ' '.repeat(half), style: 'text' }];
    return [...head(l, which === 'old' ? l.old : l.new), ...codeSpans(expand(l.text), lang, half - gutter, bandOf(l.sign), word, wordOf(l.sign), !last || l.sign !== ' ')];
  };
  hunks.forEach((hunk, h) => {
    if (h > 0) rows.push({ line: { spans: [pad, { text: '⋯', style: 'faint' }] }, changed: 0 });
    for (const b of blocks(hunk)) {
      if (b.ctx) {
        if (layout === 'split') rows.push({ line: { spans: [pad, ...side(b.ctx, 'old', undefined, false), { text: SEP, style: 'faint' }, ...side(b.ctx, 'new', undefined, true)] }, changed: 0 });
        else unified(b.ctx, undefined);
        continue;
      }
      // Each removed line is paired with the added line in the same place of its block.
      const words = b.del.map((d, k) => (b.add[k] ? wordRun(expand(d.text), expand(b.add[k]!.text)) : undefined));
      if (layout === 'split') {
        for (let k = 0; k < Math.max(b.del.length, b.add.length); k++) {
          rows.push({
            line: { spans: [pad, ...side(b.del[k], 'old', words[k]?.[0], false), { text: SEP, style: 'faint' }, ...side(b.add[k], 'new', words[k]?.[1], true)] },
            changed: (b.del[k] ? 1 : 0) + (b.add[k] ? 1 : 0),
          });
        }
      } else {
        // One column shows a block's removed lines before its added ones, as a unified diff does.
        b.del.forEach((d, k) => unified(d, words[k]?.[0]));
        b.add.forEach((a, k) => unified(a, words[k]?.[1]));
      }
    }
  });
  const shown = rows.slice(0, max);
  const hidden = rows.slice(max).reduce((n, r) => n + r.changed, 0);
  return { lines: shown.map((r) => r.line), hidden, layout };
}

