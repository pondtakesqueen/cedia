export type TextEdit = { old_text: string; new_text: string; replace_all?: boolean };
export type Tier = 'exact' | 'trailing-space' | 'indentation';
export type Applied = { from: number; to: number; tier: Tier; count: number };


// Tiered matching: exact text first, then whole lines ignoring trailing spaces, then ignoring indentation
// (re-indenting new_text to the file). A tier only applies when it finds exactly one place.
export function applyEdit(content: string, edit: TextEdit): { content: string; applied: Applied } | { error: string } {
  const { old_text: oldText, new_text: newText } = edit;
  if (!oldText) return { error: 'old_text is empty; use write to create a file' };
  if (oldText === newText) return { error: 'old_text and new_text are the same' };

  const first = content.indexOf(oldText);
  if (first >= 0) {
    const count = content.split(oldText).length - 1;
    if (count > 1 && !edit.replace_all)
      return { error: `old_text matches ${count} places (first at line ${lineOf(content, first)}); add surrounding lines or set replace_all` };
    const next = edit.replace_all ? content.split(oldText).join(newText) : content.slice(0, first) + newText + content.slice(first + oldText.length);
    return { content: next, applied: { from: lineOf(content, first), to: lineOf(content, first + oldText.length - 1), tier: 'exact', count } };
  }

  const lines = content.split('\n');
  const want = trimLastNewline(oldText).split('\n');
  for (const tier of ['trailing-space', 'indentation'] as const) {
    const norm = tier === 'trailing-space' ? (l: string) => l.trimEnd() : (l: string) => l.trim();
    const target = want.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + target.length <= lines.length; i++) {
      if (target.every((t, k) => norm(lines[i + k]!) === t)) hits.push(i);
    }
    if (hits.length > 1) return { error: `old_text matches ${hits.length} places when ${tier === 'trailing-space' ? 'trailing spaces are' : 'indentation is'} ignored (lines ${hits.map((h) => h + 1).join(', ')}); add surrounding lines` };
    if (hits.length === 1) {
      const at = hits[0]!;
      let repl = trimLastNewline(newText).split('\n');
      if (tier === 'indentation') repl = reindent(repl, indentOf(want), indentOf(lines.slice(at, at + want.length)));
      const next = [...lines.slice(0, at), ...(newText === '' ? [] : repl), ...lines.slice(at + want.length)].join('\n');
      return { content: next, applied: { from: at + 1, to: at + want.length, tier, count: 1 } };
    }
  }
  return { error: `old_text not found${hint(lines, want)}; read the file again and copy the text exactly` };
}

const lineOf = (s: string, index: number) => s.slice(0, index).split('\n').length;
const trimLastNewline = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s);
const indentOf = (ls: string[]) => /^\s*/.exec(ls.find((l) => l.trim()) ?? '')![0];

function reindent(lines: string[], from: string, to: string): string[] {
  return lines.map((l) => (l.trim() === '' ? l : to + (l.startsWith(from) ? l.slice(from.length) : l.trimStart())));
}

function hint(lines: string[], want: string[]): string {
  const key = want.find((l) => l.trim())?.trim();
  if (!key) return '';
  const at = lines.flatMap((l, i) => (l.includes(key) ? [i + 1] : [])).slice(0, 5);
  return at.length ? ` (its first line appears at line ${at.join(', ')})` : '';
}

