import React from 'react';
import { Box, Text } from 'ink';
import type { ThemeTokens } from './theme-tokens.ts';

// cedia's own markdown for the terminal: a line-based renderer whose every color comes from the theme tokens.
// It is synchronous, so the rows a reply takes are known before it paints (mdPlain is exactly what shows), and
// it tolerates the half-written markdown of a streaming reply (an unclosed fence is code to the end).
// Headings lose their #, bullets become •, a code block gets a left rule and a label for its language.

export type MdStyle = 'text' | 'muted' | 'faint' | 'heading' | 'bold' | 'italic' | 'code' | 'link' | 'bullet' | 'quote' | 'kw' | 'str' | 'com' | 'num' | 'fn';
export type MdSpan = { text: string; style: MdStyle };
export type MdLine = MdSpan[];

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*\|?\s*$/;

// Inline markdown: code, bold, italic and links. Unmatched markers stay as typed.
const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![\w*])\*(?![\s*])([^*]+?)\*(?!\*)|(?<![\w_])_(?![\s_])([^_]+?)_(?![\w_])|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function inline(src: string, base: MdStyle = 'text'): MdLine {
  const out: MdLine = [];
  let at = 0;
  for (const m of src.matchAll(INLINE)) {
    if (m.index! > at) out.push({ text: src.slice(at, m.index), style: base });
    if (m[2] !== undefined) out.push({ text: m[2], style: 'code' });
    // Bold and italic hold markdown of their own: **`add`** is code, not backticks.
    else if (m[3] !== undefined || m[4] !== undefined) out.push(...inline((m[3] ?? m[4])!, base === 'heading' ? 'heading' : 'bold'));
    else if (m[5] !== undefined || m[6] !== undefined) out.push(...inline((m[5] ?? m[6])!, 'italic'));
    else if (m[7] !== undefined) {
      out.push({ text: m[7], style: 'link' });
      if (m[8] !== m[7]) out.push({ text: ` (${m[8]})`, style: 'faint' });
    }
    at = m.index! + m[0].length;
  }
  if (at < src.length) out.push({ text: src.slice(at), style: base });
  return out;
}

const KEYWORDS = new Set(
  ('const let var function return if else for while do switch case break continue new class extends import export from default async await ' +
    'try catch finally throw typeof instanceof in of interface type enum implements public private protected static readonly ' +
    'def elif lambda pass None True False self fn pub mut impl struct trait use mod match loop where func package go defer chan range nil ' +
    'true false null undefined this void yield with as is not and or then fi done esac local').split(' '),
);
const HASH_COMMENT = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'console', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'r', 'dockerfile', 'makefile', 'ini', 'conf']);
const TOKEN = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;

// A light highlighter: comments, strings, numbers, keywords and called names. Enough to read code by, and the
// same for every language, so a wrong guess only ever costs color.
export function highlight(line: string, lang: string): MdLine {
  const hash = HASH_COMMENT.has(lang.toLowerCase());
  const out: MdLine = [];
  let at = 0;
  const push = (text: string, style: MdStyle) => {
    const last = out[out.length - 1];
    if (last && last.style === style) last.text += text;
    else out.push({ text, style });
  };
  for (const m of line.matchAll(TOKEN)) {
    const [tok, comment, str, num, call, word] = m;
    if (comment !== undefined && ((comment.startsWith('#') && !hash) || (comment.startsWith('//') && hash))) {
      // Not a comment in this language: leave it for the plain run.
      continue;
    }
    if (m.index! > at) push(line.slice(at, m.index), 'text');
    if (comment !== undefined) push(tok, 'com');
    else if (str !== undefined) push(tok, 'str');
    else if (num !== undefined) push(tok, 'num');
    else if (call !== undefined) push(tok, KEYWORDS.has(tok) ? 'kw' : 'fn');
    else if (word !== undefined) push(tok, KEYWORDS.has(tok) ? 'kw' : 'text');
    at = m.index! + tok.length;
    if (comment !== undefined) break;
  }
  if (at < line.length) push(line.slice(at), 'text');
  return out;
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function table(rows: string[]): MdLine[] {
  const body = rows.filter((r) => !TABLE_SEP.test(r)).map(cells);
  const n = Math.max(...body.map((r) => r.length));
  const plain = (c: string) => inline(c).map((s) => s.text).join('');
  const widths = Array.from({ length: n }, (_, i) => Math.max(...body.map((r) => plain(r[i] ?? '').length)));
  const out: MdLine[] = [];
  body.forEach((r, ri) => {
    const line: MdLine = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) line.push({ text: ' │ ', style: 'faint' });
      const c = r[i] ?? '';
      line.push(...inline(c, ri === 0 ? 'bold' : 'text'));
      const pad = widths[i]! - plain(c).length;
      if (pad > 0 && i < n - 1) line.push({ text: ' '.repeat(pad), style: 'text' });
    }
    out.push(line);
    if (ri === 0) out.push([{ text: widths.map((w) => '─'.repeat(w)).join('─┼─'), style: 'faint' }]);
  });
  return out;
}

export function mdLines(src: string): MdLine[] {
  const lines = (src ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  const out: MdLine[] = [];
  let fence: { mark: string; lang: string } | null = null;
  const blank = () => {
    if (out.length && out[out.length - 1]!.length) out.push([]);
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (fence) {
      if (ln.trim().startsWith(fence.mark)) { fence = null; continue; }
      out.push([{ text: '┃ ', style: 'faint' }, ...highlight(ln, fence.lang)]);
      continue;
    }
    const f = FENCE.exec(ln);
    if (f) {
      fence = { mark: f[1]!, lang: f[2] ?? '' };
      if (fence.lang) out.push([{ text: '┃ ', style: 'faint' }, { text: fence.lang, style: 'muted' }]);
      continue;
    }
    if (!ln.trim()) { blank(); continue; }
    if (TABLE_ROW.test(ln)) {
      const rows = [ln];
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1]!)) rows.push(lines[++i]!);
      out.push(...table(rows));
      continue;
    }
    const h = HEADING.exec(ln);
    if (h) { out.push(inline(h[2]!, 'heading')); continue; }
    if (RULE.test(ln)) { out.push([{ text: '─'.repeat(40), style: 'faint' }]); continue; }
    const q = QUOTE.exec(ln);
    if (q) { out.push([{ text: '│ ', style: 'faint' }, ...inline(q[1]!, 'quote')]); continue; }
    const it = ITEM.exec(ln);
    if (it) {
      const depth = Math.floor(it[1]!.replace(/\t/g, '  ').length / 2);
      const indent = '  '.repeat(depth + 1);
      const ordered = /\d/.test(it[2]!);
      let rest = it[3]!;
      let mark = ordered ? `${it[2]!.replace(')', '.')} ` : '• ';
      const task = /^\[([ xX])\]\s+/.exec(rest);
      if (task) { mark = task[1] === ' ' ? '☐ ' : '☑ '; rest = rest.slice(task[0].length); }
      out.push([{ text: indent, style: 'text' }, { text: mark, style: ordered ? 'muted' : 'bullet' }, ...inline(rest)]);
      continue;
    }
    out.push(inline(ln.replace(/^\s{0,3}/, '')));
  }
  while (out.length && !out[out.length - 1]!.length) out.pop();
  return out;
}

/** The text a reply shows, line for line: what the row budget and selection count. */
export function mdPlain(src: string): string {
  return mdLines(src).map((l) => l.map((s) => s.text).join('')).join('\n');
}

/** Kept for callers that want the rendered text; synchronous underneath. */
export async function renderMarkdown(src: string): Promise<string> {
  return mdPlain(src);
}

export function spanProps(style: MdStyle, T: ThemeTokens): { color?: string; bold?: boolean; italic?: boolean; dimColor?: boolean } {
  switch (style) {
    case 'heading': return { color: T.heading, bold: true };
    case 'bold': return { bold: true };
    case 'italic': return { italic: true };
    case 'code': return { color: T.code };
    case 'link': return { color: T.link };
    case 'bullet': return { color: T.primary };
    case 'muted': return { color: T.textMuted };
    case 'faint': return { color: T.textFaint };
    case 'quote': return { color: T.textMuted, italic: true };
    case 'kw': return { color: T.synKeyword };
    case 'str': return { color: T.synString };
    case 'com': return { color: T.synComment, italic: true };
    case 'num': return { color: T.synNumber };
    case 'fn': return { color: T.synFunction };
    default: return {};
  }
}

/**
 * The lines of a message partly off screen: `drop` leaves out the last ones (below the screen), then `tail` keeps
 * only the last of the rest (above it). Each line is at least one row; one line always stays.
 */
export function clipLines<X>(xs: X[], clip: { drop: number; tail?: number } | undefined): X[] {
  if (!clip) return xs;
  const shown = xs.slice(0, Math.max(1, xs.length - clip.drop));
  return clip.tail !== undefined && shown.length > clip.tail ? shown.slice(-clip.tail) : shown;
}

export default function Markdown({ children, T, plain, clip }: { children: string; T: ThemeTokens; plain?: boolean; clip?: { drop: number; tail?: number } }): React.ReactElement {
  const all = React.useMemo(() => mdLines(children ?? ''), [children]);
  const lines = clipLines(all, clip);
  if (plain) return <Text wrap="wrap">{lines.map((l) => l.map((s) => s.text).join('')).join('\n')}</Text>;
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} wrap="wrap" color={T.text}>
          {l.length ? l.map((s, j) => <Text key={j} {...spanProps(s.style, T)}>{s.text}</Text>) : ' '}
        </Text>
      ))}
    </Box>
  );
}
