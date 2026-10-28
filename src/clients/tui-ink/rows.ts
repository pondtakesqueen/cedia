import type { MdStyle } from './markdown.tsx';

// The transcript rows a turn adds besides the reply itself: one per tool call, the thinking marker and the line
// that ends a turn. A row is styled spans per line; its text (the spans joined) is exactly what shows, so the
// row budget, selection and search count the same characters the terminal paints.
//
//   ✓ Edit  math.js · +1 −1          status glyph, tool name, target, then a summary
//       2 - return a - b;           an edit's lines, on a red or green band
//       2 + return a + b;
//   ✗ Bash  rm -rf dist · blocked
//     └ deny rule: rm -rf *        detail under the call, quieter

export type RowStyle = MdStyle | 'status' | 'name' | 'ok' | 'err' | 'accent' | 'thinking';
export type RowSpan = { text: string; style: RowStyle };
export type RowLine = { spans: RowSpan[]; band?: 'add' | 'del' };

export const rowText = (lines: RowLine[]): string => lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n');

const NAMES: Record<string, string> = {
  read: 'Read', edit: 'Edit', write: 'Write', bash: 'Bash', grep: 'Grep', glob: 'Glob', ls: 'List',
  web_fetch: 'Fetch', web_search: 'Search', skill: 'Skill', todo: 'Todo', spawn: 'Spawn', ask_user: 'Ask', browser: 'Browser',
};

export function toolName(tool: string): string {
  if (NAMES[tool]) return NAMES[tool]!;
  const t = tool.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** What a call works on, in one line: its command, path, pattern or url. */
export function toolTarget(input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const v = o.command ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.name ?? o.file_path ?? Object.values(o).find((x) => typeof x === 'string');
  return typeof v === 'string' ? v.split('\n')[0]!.replace(/\s+/g, ' ').trim() : '';
}

const clip = (s: string, n: number) => (n <= 1 ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s);

function head(tool: string, input: unknown, width: number): RowSpan[] {
  const name = toolName(tool);
  const target = clip(toolTarget(input), Math.max(8, width - name.length - 24));
  return [{ text: '●', style: 'status' }, { text: ' ', style: 'text' }, { text: name, style: 'name' }, ...(target ? [{ text: `  ${target}`, style: 'text' as const }] : [])];
}

export function intentRow(tool: string, input: unknown, width: number): RowLine[] {
  return [{ spans: head(tool, input, width) }];
}

export type DiffLine = { sign: '+' | '-'; n: number; text: string };

/** An edit call's changed lines, from its input and the line numbers the edit tool reports. */
export function editDiff(input: unknown, output: string): { added: number; removed: number; lines: DiffLine[] } {
  const edits = (input as { edits?: unknown })?.edits;
  if (!Array.isArray(edits)) return { added: 0, removed: 0, lines: [] };
  const starts = [...output.matchAll(/^edit (\d+): lines (\d+)-/gm)].reduce<Record<number, number>>((acc, m) => ({ ...acc, [Number(m[1])]: Number(m[2]) }), {});
  let added = 0;
  let removed = 0;
  const lines: DiffLine[] = [];
  edits.forEach((e, i) => {
    const o = String((e as { old_text?: unknown })?.old_text ?? '').split('\n');
    const n = String((e as { new_text?: unknown })?.new_text ?? '').split('\n');
    let pre = 0;
    while (pre < o.length && pre < n.length && o[pre] === n[pre]) pre++;
    let post = 0;
    while (post < o.length - pre && post < n.length - pre && o[o.length - 1 - post] === n[n.length - 1 - post]) post++;
    const from = (starts[i + 1] ?? 1) + pre;
    const gone = o.slice(pre, o.length - post);
    const come = n.slice(pre, n.length - post);
    removed += gone.length;
    added += come.length;
    gone.forEach((t, k) => lines.push({ sign: '-', n: from + k, text: t }));
    come.forEach((t, k) => lines.push({ sign: '+', n: from + k, text: t }));
  });
  return { added, removed, lines };
}

const MAX_DIFF = 6;

export function resultRow(
  tool: string,
  input: unknown,
  output: { text: string; isError?: boolean; exitCode?: number },
  ms: number | undefined,
  width: number,
): RowLine[] {
  const first: RowSpan[] = head(tool, input, width);
  const detail: RowLine[] = [];
  const sum: RowSpan[] = [];
  const text = output.text ?? '';
  const nonEmpty = text.split('\n').filter((l) => l.trim());
  const sub = (s: string, style: RowStyle = 'muted') =>
    detail.push({ spans: [{ text: '  └ ', style: 'faint' }, { text: clip(s.replace(/\t/g, '  '), Math.max(10, width - 6)), style }] });
  if (output.isError) {
    sub(nonEmpty[0] ?? 'failed', 'err');
  } else if (tool === 'read') {
    sum.push({ text: `${nonEmpty.length} line${nonEmpty.length === 1 ? '' : 's'}`, style: 'muted' });
  } else if (tool === 'edit') {
    const d = editDiff(input, text);
    sum.push({ text: `+${d.added}`, style: 'ok' }, { text: ' ', style: 'muted' }, { text: `−${d.removed}`, style: 'err' });
    const w = String(Math.max(0, ...d.lines.map((l) => l.n))).length;
    for (const l of d.lines.slice(0, MAX_DIFF)) {
      detail.push({
        band: l.sign === '+' ? 'add' : 'del',
        spans: [
          { text: `   ${String(l.n).padStart(w)} `, style: 'muted' },
          { text: l.sign === '+' ? '+' : '-', style: l.sign === '+' ? 'ok' : 'err' },
          { text: ` ${clip(l.text.replace(/\t/g, '  '), Math.max(10, width - w - 8))}`, style: 'text' },
        ],
      });
    }
    if (d.lines.length > MAX_DIFF) detail.push({ spans: [{ text: `     … ${d.lines.length - MAX_DIFF} more lines · /diff`, style: 'faint' }] });
  } else if (tool === 'write') {
    const n = String((input as { content?: unknown })?.content ?? '').split('\n').length;
    sum.push({ text: `+${n} line${n === 1 ? '' : 's'}`, style: 'ok' });
  } else if (tool === 'bash') {
    if (output.exitCode !== undefined && output.exitCode !== 0) sum.push({ text: `exit ${output.exitCode}`, style: 'err' });
    // The bash tool closes its output with "[exit N]" and marks stderr; the row already says how it ended.
    const shown = nonEmpty.filter((l) => !/^\[exit -?\d+/.test(l) && l !== '[stderr]' && l !== '(no output)');
    if (shown.length) sub(shown.length > 1 ? `${shown[0]}  (+${shown.length - 1} lines)` : shown[0]!);
  } else if (nonEmpty.length > 1) {
    sum.push({ text: `${nonEmpty.length} lines`, style: 'muted' });
  } else if (nonEmpty.length === 1) {
    sub(nonEmpty[0]!);
  }
  if (ms !== undefined && ms >= 1000) sum.push({ text: `${sum.length ? ' · ' : ''}${(ms / 1000).toFixed(1)}s`, style: 'muted' });
  if (sum.length) first.push({ text: ' · ', style: 'faint' }, ...sum);
  return [{ spans: first }, ...detail];
}

export function deniedRow(tool: string, input: unknown, rule: string, reason: string | undefined, width: number): RowLine[] {
  return [
    { spans: [...head(tool, input, width), { text: ' · ', style: 'faint' }, { text: 'blocked', style: 'err' }] },
    { spans: [{ text: '  └ ', style: 'faint' }, { text: clip(`${rule}${reason ? `: ${reason}` : ''}`, Math.max(10, width - 6)), style: 'muted' }] },
  ];
}

export function thinkingRow(text: string, ms: number | undefined, expanded: boolean): RowLine[] {
  const took = ms !== undefined && ms >= 100 ? ` for ${(ms / 1000).toFixed(1)}s` : '';
  const top: RowLine = { spans: [{ text: `∴ Thought${took}`, style: 'thinking' }, { text: expanded ? '' : '  alt+t to expand', style: 'faint' }] };
  if (!expanded) return [top];
  return [top, ...text.split('\n').map((l) => ({ spans: [{ text: `  ${l}`, style: 'quote' as const }] }))];
}

export type TurnEnd = { subtype: string; ms: number; tools: number; files: number; costUsd: number };

export function doneRow(t: TurnEnd): RowLine[] {
  const facts = [`in ${(t.ms / 1000).toFixed(1)}s`, t.tools ? `${t.tools} tool${t.tools === 1 ? '' : 's'}` : '', t.files ? `${t.files} file${t.files === 1 ? '' : 's'} changed` : '', `$${t.costUsd.toFixed(4)}`].filter(Boolean).join(' · ');
  if (t.subtype === 'success') {
    return [{ spans: [{ text: '✓ Done', style: 'ok' }, { text: ` ${facts}`, style: 'muted' }, { text: t.files ? '   /diff  /undo  /commit' : '', style: 'faint' }] }];
  }
  const [mark, style] = END_MARKS[t.subtype] ?? [`✗ Ended: ${t.subtype.replace(/_/g, ' ')}`, 'err' as const];
  return [{ spans: [{ text: mark, style }, { text: ` ${facts}`, style: 'muted' }] }];
}

const END_MARKS: Record<string, [string, RowStyle]> = {
  asked: ['? Waiting for your answer', 'accent'],
  handoff: ['✓ Handed off to a new session', 'ok'],
  interrupted: ['■ Stopped', 'accent'],
  error_max_turns: ['✗ Hit the turn limit', 'err'],
  error_max_budget_usd: ['✗ Hit the budget', 'err'],
  error_during_execution: ['✗ Failed', 'err'],
  error_unverified_claim: ['✗ Claimed done without proof', 'err'],
  error_stuck: ['✗ Stopped going in circles', 'err'],
};

export function rowProps(style: RowStyle, T: { text: string; textMuted: string; textFaint: string; success: string; error: string; accent: string; thinking: string }): { color?: string; bold?: boolean; italic?: boolean } | undefined {
  switch (style) {
    case 'name': return { bold: true };
    case 'ok': return { color: T.success };
    case 'err': return { color: T.error };
    case 'accent': return { color: T.accent };
    case 'thinking': return { color: T.thinking, italic: true };
    default: return undefined;
  }
}
