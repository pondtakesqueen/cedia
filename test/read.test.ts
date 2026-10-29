import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_OUTPUT_CHARS } from '../src/core/tools/registry.ts';
import { readTool } from '../src/core/tools/read.ts';

describe('read', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cedia-read-'));
  const ctx = { cwd, signal: new AbortController().signal };
  writeFileSync(join(cwd, 'three.txt'), 'a\nb\nc\n');
  writeFileSync(join(cwd, 'empty.txt'), '');
  // 1500 lines of 60 characters: under the line limit, three times the character budget.
  writeFileSync(join(cwd, 'big.ts'), Array.from({ length: 1500 }, (_, i) => `const line${String(i + 1).padStart(4, '0')} = ${'x'.repeat(40)};`).join('\n'));
  const read = (input: Record<string, unknown>) => readTool.run(input as never, ctx);

  test('an offset past the end says so, instead of calling the file empty', async () => {
    expect(await read({ path: 'three.txt', offset: 10 })).toEqual({ text: 'three.txt has 3 lines; offset 10 is past the end', isError: true });
    expect(await read({ path: 'empty.txt' })).toEqual({ text: '(empty file)', isError: false });
  });

  test('an offset or limit that is not a number falls back to the default; one sent as a string is taken', async () => {
    expect((await read({ path: 'three.txt', offset: 'x', limit: 'all' })).text).toBe('     1\ta\n     2\tb\n     3\tc');
    expect((await read({ path: 'three.txt', offset: '2', limit: '1' })).text).toBe('     2\tb\n[1 more lines; read on with offset 3]');
  });

  test('a file past the character budget is paged in whole lines, with the offset to go on from', async () => {
    const r = await read({ path: 'big.ts' });
    expect(r.text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 100);
    expect(r.text).not.toContain('characters cut');
    const rows = r.text.split('\n').slice(0, -1);
    expect(rows.every((row, i) => row.startsWith(`${String(i + 1).padStart(6)}\tconst line${String(i + 1).padStart(4, '0')}`))).toBe(true);
    const next = rows.length + 1;
    expect(r.text.split('\n').at(-1)).toBe(`[${1500 - next + 1} more lines; read on with offset ${next}]`);
    const on = await read({ path: 'big.ts', offset: next });
    expect(on.text.startsWith(`${String(next).padStart(6)}\tconst line${String(next).padStart(4, '0')}`)).toBe(true);
  });

  test('one line longer than the budget is still shown, clipped', async () => {
    writeFileSync(join(cwd, 'min.js'), 'y'.repeat(MAX_OUTPUT_CHARS * 2) + '\nz\n');
    const r = await read({ path: 'min.js' });
    expect(r.text).toContain('characters cut');
    expect(r.text).toEndWith('[1 more lines; read on with offset 2]');
  });
});
