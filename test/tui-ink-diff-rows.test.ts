import { describe, expect, test } from 'bun:test';
import { diffRows, hunkOf, langOf, SPLIT_MIN_WIDTH, wordRun } from '../src/clients/tui-ink/diff-rows.ts';
import type { RowLine } from '../src/clients/tui-ink/rows.ts';

const plain = (lines: RowLine[]) => lines.map((l) => l.spans.map((s) => s.text).join(''));

const OLD = ['function retry(fn, tries) {', '  let last;', '  for (let i = 0; i < tries; i++) {', '    try { return fn(); }', '    catch (e) { last = e; }', '  }', '  throw last;', '}'].join('\n');
const NEW = ['function retry(fn, tries) {', '  let last;', '  for (let attempt = 1; attempt <= tries; attempt++) {', '    try { return fn(); }', '    catch (e) {', '      last = e;', '      log(attempt);', '    }', '  }', '  throw last;', '}'].join('\n');

describe('edit diffs as rows', () => {
  test('a hunk keeps two unchanged lines on each side, and the lines both sides keep between, numbered on each side', () => {
    const { hunk, added, removed } = hunkOf(OLD, NEW, 10);
    expect({ added, removed }).toEqual({ added: 5, removed: 2 });
    expect(hunk.map((l) => `${l.sign}${l.old ?? ''}/${l.new ?? ''}`)).toEqual([
      ' 10/10', ' 11/11', '-12/', '+/12', ' 13/13', '-14/', '+/14', '+/15', '+/16', '+/17', ' 15/18', ' 16/19',
    ]);
    // An edit that only adds keeps its context, and one with no known line has no numbers.
    expect(hunkOf('a\nb', 'a\nx\nb', undefined).hunk).toEqual([
      { sign: ' ', old: undefined, new: undefined, text: 'a' },
      { sign: '+', new: undefined, text: 'x' },
      { sign: ' ', old: undefined, new: undefined, text: 'b' },
    ]);
  });

  test('the changed run of a pair leaves out the shared start and end and the spaces at its edges', () => {
    expect(wordRun('  for (let i = 0; i < n; i++) {', '  for (let k = 0; k < n; k++) {')).toEqual([[11, 26], [11, 26]]);
    expect(wordRun('    catch (e) { last = e; }', '    catch (e) {')).toEqual([[16, 27], [15, 15]]);
    expect(wordRun('abc', 'xyz')).toBeUndefined();
  });

  test('a wide row splits old and new side by side, each block filling the shorter side with space', () => {
    const { lines, layout, hidden } = diffRows([hunkOf(OLD, NEW, 10).hunk], 140, 'ts', 3, 20);
    expect(layout).toBe('split');
    expect(hidden).toBe(0);
    const rows = plain(lines);
    // Context, a changed line, the kept try line, then one removed against four added: the left runs out.
    expect(rows).toHaveLength(2 + 1 + 1 + 4 + 2);
    for (const r of rows) expect(r).toContain(' │ ');
    const at = rows[0]!.indexOf(' │ ');
    for (const r of rows) expect(r.indexOf(' │ ')).toBe(at);
    expect(rows[2]).toMatch(/^ {3}12 - {3}for \(let i = 0; i < tries; i\+\+\) \{ +│ 12 \+ {3}for \(let attempt = 1/);
    expect(rows[6]).toMatch(/^ +│ 16 \+ {7}log\(attempt\); *$/);
    expect(rows.at(-1)).toMatch(/^ {3}16 {5}throw last; +│ 19 {5}throw last;$/);
    // Each side's changed characters get the stronger band, the rest of the line its own.
    const bands = lines[2]!.spans.map((s) => s.bg).filter(Boolean);
    expect(bands).toContain('delWord');
    expect(bands).toContain('addWord');
    expect(lines[2]!.band).toBeUndefined();
  });

  test('a narrow row, or a line too long for half the row, is one column with removed lines first', () => {
    for (const width of [SPLIT_MIN_WIDTH - 1, 80]) {
      const { lines, layout } = diffRows([hunkOf(OLD, NEW, 10).hunk], width, 'ts', 3, 20);
      expect(layout).toBe('unified');
      expect(plain(lines).map((r) => r.slice(3, 7))).toEqual(['10  ', '11  ', '12 -', '12 +', '13  ', '14 -', '14 +', '15 +', '16 +', '17 +', '15  ', '16  ']);
      expect(lines.map((l) => l.band)).toEqual([undefined, undefined, 'del', 'add', undefined, 'del', 'add', 'add', 'add', 'add', undefined, undefined]);
    }
    const long = hunkOf('x = 1', `x = ${'1'.repeat(80)}`, 1).hunk;
    expect(diffRows([long], 140, 'ts', 3).layout).toBe('unified');
    // One column cuts a line too long for the row.
    const cut = plain(diffRows([long], 60, 'ts', 3).lines);
    expect(cut[1]!.length).toBe(60);
    expect(cut[1]!.endsWith('…')).toBe(true);
  });

  test('code takes the highlighter colors, and a path picks the comment marker', () => {
    const { lines } = diffRows([hunkOf('const a = 1;', 'const a = 2; // two', 1).hunk], 80, langOf('x.ts'), 0);
    const styles = lines.flatMap((l) => l.spans.map((s) => s.style));
    expect(styles).toContain('kw');
    expect(styles).toContain('num');
    expect(styles).toContain('com');
    expect(langOf('run.py')).toBe('py');
    expect(langOf('Makefile')).toBe('ts');
  });

  test('hunks are set apart, and rows past the limit become a count of changed lines', () => {
    const a = hunkOf('a', 'b', 1).hunk;
    const b = hunkOf('c', 'd', 9).hunk;
    expect(plain(diffRows([a, b], 80, 'ts', 2).lines)).toEqual(['  1 - a', '  1 + b', '  ⋯', '  9 - c', '  9 + d']);
    expect(diffRows([a, b], 80, 'ts', 2, 3)).toMatchObject({ hidden: 2 });
  });
});
