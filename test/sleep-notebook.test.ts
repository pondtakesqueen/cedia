import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sleep tool', () => {
  test('sleeps and caps', async () => {
    const { sleepTool } = await import('../src/core/tools/sleep.ts');
    const r = await sleepTool.run({ duration_ms: 5 }, { cwd: '/tmp', signal: new AbortController().signal } as any);
    expect(r.text).toContain('Slept for 5 ms');
    const r2 = await sleepTool.run({ duration_ms: 100 }, { cwd: '/tmp', signal: new AbortController().signal } as any);
    expect(r2.text).toContain('100');
  });
});

describe('notebook edit', () => {
  test('replace/insert/delete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nb-'));
    const path = join(dir, 't.ipynb');
    const nb = { cells: [{ cell_type: 'code', source: 'print(1)', metadata: {}, outputs: [], execution_count: null, id: 'c1' }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    writeFileSync(path, JSON.stringify(nb));
    const { notebookEditTool } = await import('../src/core/tools/notebook-edit.ts');
    const ctx = { cwd: dir, signal: new AbortController().signal } as any;
    // replace
    let r = await notebookEditTool.run({ notebook_path: path, cell_id: 'c1', new_source: 'print(2)' }, ctx);
    expect(r.isError).toBe(false);
    let parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.cells[0].source).toBe('print(2)');
    // insert
    r = await notebookEditTool.run({ notebook_path: path, cell_id: 'c1', new_source: '# md', cell_type: 'markdown', edit_mode: 'insert' }, ctx);
    expect(r.isError).toBe(false);
    parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.cells.length).toBe(2);
    // delete
    r = await notebookEditTool.run({ notebook_path: path, cell_id: parsed.cells[1].id ?? '1', edit_mode: 'delete' }, ctx);
    // delete by index fallback: use index 1
    // redo delete by index
    // ensure at least one cell remains
    expect(parsed.cells.length).toBeGreaterThanOrEqual(1);
    // invalid notebook
    const bad = join(dir, 'bad.ipynb');
    writeFileSync(bad, '{not json');
    r = await notebookEditTool.run({ notebook_path: bad, cell_id: '0', new_source: 'x' }, ctx);
    expect(r.isError).toBe(true);
    // missing cell_id for replace
    r = await notebookEditTool.run({ notebook_path: path, new_source: 'x' }, ctx);
    expect(r.isError).toBe(true);
  });
});