import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slowGrepNote } from '../src/core/tools/bash.ts';
import { grepTool } from '../src/core/tools/grep.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-grep-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'build'));
  writeFileSync(join(dir, '.gitignore'), 'build/\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export function cloneState() {}\nconst x = 1;\n');
  writeFileSync(join(dir, 'src', 'b.py'), 'def clone_state(): pass\nCloneState = 1\n');
  writeFileSync(join(dir, 'build', 'out.js'), 'cloneState();\n');
  writeFileSync(join(dir, '.env'), 'CLONESTATE_TOKEN=abc\n');
  return dir;
}
const run = (dir: string, input: Record<string, unknown>) => grepTool.run(input, { cwd: dir, signal: new AbortController().signal });

describe('grep', () => {
  test('finds lines, skips what .gitignore excludes and files named like secrets', async () => {
    const dir = repo();
    const r = await run(dir, { pattern: 'cloneState' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('src/a.ts:1:export function cloneState() {}');
    expect(r.text).not.toContain('build/out.js');
    expect((await run(dir, { pattern: 'CLONESTATE', ignore_case: true })).text).not.toContain('.env');
  });

  test('case, globs, paths, files only, and no match', async () => {
    const dir = repo();
    expect((await run(dir, { pattern: 'clonestate', ignore_case: true, glob: '*.py' })).text).toBe('src/b.py:2:CloneState = 1');
    expect((await run(dir, { pattern: 'clone', files_only: true, path: 'src' })).text.split('\n').sort()).toEqual(['src/a.ts', 'src/b.py']);
    expect(await run(dir, { pattern: 'nothing_here' })).toEqual({ text: 'no matches for nothing_here in .', isError: false });
    expect((await run(dir, { pattern: '(' })).isError).toBe(true);
  });

  test('at most 200 lines, with a count of the rest', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'src', 'many.txt'), Array.from({ length: 250 }, (_, i) => `hit ${i}`).join('\n'));
    const r = await run(dir, { pattern: '^hit' });
    expect(r.text.split('\n')).toHaveLength(201);
    expect(r.text).toContain('[50 more lines: narrow the pattern, path or glob]');
  });
});

describe('a slow recursive grep in bash', () => {
  test('points to the grep tool, and only when it was recursive and slow', () => {
    expect(slowGrepNote('grep -rn cloneState .', 22_000)).toContain('took 22.0 s: the grep tool');
    expect(slowGrepNote('cd src && grep -Rl foo', 3000)).toContain('grep tool');
    expect(slowGrepNote('grep --recursive foo src', 2500)).toContain('grep tool');
    expect(slowGrepNote('grep -rn cloneState .', 300)).toBe('');
    expect(slowGrepNote('grep -n foo src/a.ts', 5000)).toBe('');
    expect(slowGrepNote('rg foo', 5000)).toBe('');
  });
});
