import { describe, expect, test } from 'bun:test';
import { deniedRow, doneRow, editDiff, intentRow, resultRow, rowText, thinkingRow, toolTarget, type RowLine } from '../src/clients/tui-ink/rows.ts';

const plain = (lines: RowLine[]) => lines.map((l) => l.spans.map((s) => s.text).join(''));

describe('ink transcript rows', () => {
  test('a call shows its tool and target; its result keeps that line and adds a summary', () => {
    const input = { path: 'math.js', edits: [{ old_text: 'export function add(a, b) {\n  return a - b;\n}', new_text: 'export function add(a, b) {\n  return a + b;\n}' }] };
    expect(plain(intentRow('edit', input, 80))).toEqual(['● Edit  math.js']);
    const done = resultRow('edit', input, { text: 'edited math.js\nedit 1: lines 1-3', isError: false }, 1500, 80);
    expect(plain(done)).toEqual(['● Edit  math.js · +1 −1 · 1.5s', '   2 -   return a - b;', '   2 +   return a + b;']);
    expect(done.slice(1).map((l) => l.band)).toEqual(['del', 'add']);
  });

  test('a diff past six lines says how many more', () => {
    const old_text = Array.from({ length: 5 }, (_, i) => `old ${i}`).join('\n');
    const new_text = Array.from({ length: 5 }, (_, i) => `new ${i}`).join('\n');
    const d = editDiff({ edits: [{ old_text, new_text }] }, 'edited x\nedit 1: lines 10-14');
    expect(d).toMatchObject({ added: 5, removed: 5 });
    expect(d.lines[0]).toEqual({ sign: '-', n: 10, text: 'old 0' });
    const rows = plain(resultRow('edit', { path: 'x', edits: [{ old_text, new_text }] }, { text: 'edited x\nedit 1: lines 10-14' }, 0, 80));
    expect(rows.at(-1)).toBe('     … 4 more lines · /diff');
  });

  test('bash shows its output without the exit marker, and a failing exit on the line', () => {
    expect(plain(resultRow('bash', { command: 'node t.js' }, { text: '5\n[exit 0]', exitCode: 0 }, 200, 80))).toEqual(['● Bash  node t.js', '  └ 5']);
    expect(plain(resultRow('bash', { command: 'false' }, { text: '(no output)\n[exit 1]', exitCode: 1 }, 0, 80))[0]).toBe('● Bash  false · exit 1');
    // The first three lines show, the rest is a count.
    expect(plain(resultRow('bash', { command: 'seq 5' }, { text: '1\n2\n3\n4\n5\n[exit 0]', exitCode: 0 }, 0, 80))).toEqual(['● Bash  seq 5', '  └ 1', '    2', '    3', '    … +2 lines']);
  });

  test('read counts lines; an error shows its first line under the call', () => {
    expect(plain(resultRow('read', { path: 'a' }, { text: '1\tx\n2\ty\n' }, 0, 80))).toEqual(['● Read  a · 2 lines']);
    expect(plain(resultRow('read', { path: 'a' }, { text: 'cannot read a: ENOENT', isError: true }, 0, 80))).toEqual(['● Read  a', '  └ cannot read a: ENOENT']);
  });

  test('a long target is cut to fit the width', () => {
    const [line] = plain(intentRow('bash', { command: 'x'.repeat(200) }, 60));
    expect(line!.length).toBeLessThanOrEqual(60);
    expect(line!.endsWith('…')).toBe(true);
    expect(toolTarget({ command: 'a\nb' })).toBe('a');
  });

  test('a denied call says it was blocked and by what', () => {
    expect(plain(deniedRow('bash', { command: 'rm -rf dist' }, 'deny', 'Bash(rm -rf *)', 80))).toEqual(['● Bash  rm -rf dist · blocked', '  └ deny: Bash(rm -rf *)']);
  });

  test('thinking is one line until expanded', () => {
    expect(plain(thinkingRow('a\nb', 1234, false))).toEqual(['∴ Thought for 1.2s  alt+t to expand']);
    expect(plain(thinkingRow('a\nb', 1234, true))).toEqual(['∴ Thought for 1.2s', '  a', '  b']);
  });

  test('the turn line names how it ended', () => {
    expect(plain(doneRow({ subtype: 'success', ms: 3200, tools: 3, files: 1, costUsd: 0.0045 }))).toEqual(['✓ Done in 3.2s · 3 tools · 1 file changed · $0.0045   /diff  /undo  /commit']);
    expect(plain(doneRow({ subtype: 'success', ms: 100, tools: 0, files: 0, costUsd: 0 }))).toEqual(['✓ Done in 0.1s · $0.0000']);
    expect(plain(doneRow({ subtype: 'interrupted', ms: 100, tools: 0, files: 0, costUsd: 0 }))[0]).toStartWith('■ Stopped');
  });

  test('rowText is the spans joined, line by line', () => {
    const lines = resultRow('edit', { path: 'm', edits: [{ old_text: 'a', new_text: 'b' }] }, { text: 'edited m\nedit 1: lines 4-4' }, 0, 80);
    expect(rowText(lines)).toBe(plain(lines).join('\n'));
  });
});
