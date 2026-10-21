import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdit, editsOf, editTool, writeTool } from '../src/core/tools/edit.ts';

const cwd = mkdtempSync(join(tmpdir(), 'cedia-edit-'));
const ctx = { cwd, signal: new AbortController().signal };
const SRC = 'function f() {\n    if (a) {\n        return 1;  \n    }\n}\n';

describe('applyEdit tiers', () => {
  test('exact match', () => {
    const r = applyEdit(SRC, { old_text: 'return 1;', new_text: 'return 2;' });
    expect(r).toMatchObject({ applied: { tier: 'exact', from: 3, to: 3 } });
    expect('content' in r && r.content).toContain('return 2;  ');
  });

  test('trailing spaces ignored when exact fails', () => {
    const r = applyEdit(SRC, { old_text: '    if (a) {\n        return 1;\n    }', new_text: '    if (a) {\n        return 3;\n    }' });
    expect(r).toMatchObject({ applied: { tier: 'trailing-space', from: 2, to: 4 } });
    expect('content' in r && r.content).toBe('function f() {\n    if (a) {\n        return 3;\n    }\n}\n');
  });

  test('indentation ignored, new_text re-indented to the file', () => {
    const r = applyEdit(SRC, { old_text: 'if (a) {\n    return 1;\n}', new_text: 'if (b) {\n    return 1;\n}' });
    expect(r).toMatchObject({ applied: { tier: 'indentation', from: 2, to: 4 } });
    expect('content' in r && r.content).toBe('function f() {\n    if (b) {\n        return 1;\n    }\n}\n');
  });

  test('ambiguous and missing text are errors with a pointer', () => {
    expect(applyEdit('x\nx\n', { old_text: 'x', new_text: 'y' })).toEqual({ error: expect.stringContaining('matches 2 places') });
    expect(applyEdit('x\nx\n', { old_text: 'x', new_text: 'y', replace_all: true })).toMatchObject({ content: 'y\ny\n' });
    expect(applyEdit(SRC, { old_text: 'if (a) {\n  return 9;', new_text: '' })).toEqual({ error: expect.stringContaining('first line appears at line 2') });
    expect(applyEdit(SRC, { old_text: '', new_text: 'x' })).toEqual({ error: expect.stringContaining('use write') });
  });
});

describe('edit and write tools', () => {
  test('edits apply in order, all or none, and keep CRLF', async () => {
    const p = join(cwd, 'crlf.txt');
    writeFileSync(p, 'one\r\ntwo\r\nthree\r\n');
    const bad = await editTool.run({ path: 'crlf.txt', edits: [{ old_text: 'one', new_text: '1' }, { old_text: 'nope', new_text: 'x' }] }, ctx);
    expect(bad).toMatchObject({ isError: true, text: expect.stringContaining('edit 2 of 2') });
    expect(readFileSync(p, 'utf8')).toBe('one\r\ntwo\r\nthree\r\n');
    const ok = await editTool.run({ path: 'crlf.txt', edits: [{ old_text: 'one\ntwo', new_text: '1\n2' }, { old_text: '2', new_text: 'II' }] }, ctx);
    expect(ok.isError).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('1\r\nII\r\nthree\r\n');
  });

  // The shapes Haiku 5.5 sent in 179 of 418 edit calls in the eval logs.
  test('takes old_text and new_text at the top level, and edits as a string', async () => {
    const one = [{ old_text: 'a', new_text: 'b' }];
    expect(editsOf({ path: 'f', old_text: 'a', new_text: 'b' })).toEqual(one);
    expect(editsOf({ path: 'f', old_text: 'a', new_text: 'b', replace_all: true })).toEqual([{ ...one[0]!, replace_all: true }]);
    expect(editsOf({ path: 'f', edits: '[{"old_text">a', new_text: 'b' })).toEqual(one);
    expect(editsOf({ path: 'f', edits: JSON.stringify(one) })).toEqual(one);
    expect(editsOf({ path: 'f', edits: '[{"old_text">a' })).toEqual({ error: expect.stringContaining('not a string') });
    expect(editsOf({ path: 'f', edits: '[{oops' })).toEqual({ error: expect.stringContaining('not a string') });
    expect(editsOf({ path: 'f' })).toEqual({ error: expect.stringContaining('edits is required') });
    expect(editsOf({ path: 'f', edits: [] })).toEqual({ error: 'edits is empty' });
    expect(editsOf({ path: 'f', edits: [{ old_text: 'a' }] })).toEqual({ error: 'edits[0] needs old_text and new_text strings' });

    const p = join(cwd, 'flat.txt');
    writeFileSync(p, 'const port = 80;\n');
    expect((await editTool.run({ path: 'flat.txt', old_text: '80', new_text: '8080' }, ctx)).isError).toBe(false);
    expect((await editTool.run({ path: 'flat.txt', edits: '[{"old_text">8080', new_text: '9090' }, ctx)).isError).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('const port = 9090;\n');
  });

  test('write creates parents and reports created or replaced', async () => {
    expect((await writeTool.run({ path: 'deep/new/a.ts', content: 'a\nb\n' }, ctx)).text).toBe('created deep/new/a.ts (2 lines)');
    expect((await writeTool.run({ path: 'deep/new/a.ts', content: 'c\n' }, ctx)).text).toBe('replaced deep/new/a.ts (1 lines)');
    expect(readFileSync(join(cwd, 'deep/new/a.ts'), 'utf8')).toBe('c\n');
  });
});
