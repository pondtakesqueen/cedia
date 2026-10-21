import { describe, expect, test } from 'bun:test';
import { applyEdit } from './edit.ts';

const SRC = 'function f() {\n    if (a) {\n        return 1;  \n    }\n}\n';
const ok = (r: ReturnType<typeof applyEdit>) => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('exact', () => {
  test('replaces one match and reports its lines', () => {
    const r = ok(applyEdit(SRC, { old_text: 'return 1;', new_text: 'return 2;' }));
    expect(r.applied).toEqual({ from: 3, to: 3, tier: 'exact', count: 1 });
    expect(r.content).toBe('function f() {\n    if (a) {\n        return 2;  \n    }\n}\n');
  });
  test('multi-line exact match spans its lines', () => {
    const r = ok(applyEdit('a\nb\nc\nd\n', { old_text: 'b\nc', new_text: 'B\nC\nX' }));
    expect(r.applied).toEqual({ from: 2, to: 3, tier: 'exact', count: 1 });
    expect(r.content).toBe('a\nB\nC\nX\nd\n');
  });
  test('ambiguous without replace_all', () => {
    const r = applyEdit('x\ny\nx\n', { old_text: 'x', new_text: 'z' });
    expect('error' in r && r.error).toContain('matches 2 places');
    expect('error' in r && r.error).toContain('line 1');
  });
  test('replace_all replaces every occurrence', () => {
    const r = ok(applyEdit('x\ny\nx\n', { old_text: 'x', new_text: 'z', replace_all: true }));
    expect(r.content).toBe('z\ny\nz\n');
    expect(r.applied.count).toBe(2);
    expect(r.applied.tier).toBe('exact');
  });
});

describe('trailing-space', () => {
  test('matches lines whose trailing spaces differ', () => {
    const r = ok(applyEdit(SRC, { old_text: '    if (a) {\n        return 1;\n    }', new_text: '    if (a) {\n        return 3;\n    }' }));
    expect(r.applied).toEqual({ from: 2, to: 4, tier: 'trailing-space', count: 1 });
    expect(r.content).toBe('function f() {\n    if (a) {\n        return 3;\n    }\n}\n');
  });
  test('a trailing newline on old_text and new_text is ignored', () => {
    const r = ok(applyEdit('a  \nb\n', { old_text: 'a\n', new_text: 'A\n' }));
    expect(r.content).toBe('A\nb\n');
  });
  test('two windows match: error with their lines', () => {
    const r = applyEdit('a \nb\na  \nb\n', { old_text: 'a\nb', new_text: 'c' });
    expect('error' in r && r.error).toContain('matches 2 places');
    expect('error' in r && r.error).toContain('1, 3');
  });
});

describe('indentation', () => {
  test('re-indents new_text to the file', () => {
    const r = ok(applyEdit(SRC, { old_text: 'if (a) {\n    return 1;\n}', new_text: 'if (b) {\n    return 1;\n}' }));
    expect(r.applied).toEqual({ from: 2, to: 4, tier: 'indentation', count: 1 });
    expect(r.content).toBe('function f() {\n    if (b) {\n        return 1;\n    }\n}\n');
  });
  test('tabs in the file, spaces in old_text', () => {
    const r = ok(applyEdit('if x:\n\tdo()\n\tdone()\n', { old_text: '  do()\n  done()', new_text: '  do()\n  log()\n  done()' }));
    expect(r.content).toBe('if x:\n\tdo()\n\tlog()\n\tdone()\n');
  });
  test('blank lines stay blank and empty new_text deletes', () => {
    const r = ok(applyEdit('a\n  b\n  c\nd\n', { old_text: 'b\nc', new_text: '' }));
    expect(r.content).toBe('a\nd\n');
    const r2 = ok(applyEdit('a\n  b\n  e\nd\n', { old_text: 'b\ne', new_text: 'b\n\nc' }));
    expect(r2.content).toBe('a\n  b\n\n  c\nd\n');
  });
});

describe('errors', () => {
  test('empty old_text and no-op edits', () => {
    expect(applyEdit(SRC, { old_text: '', new_text: 'x' })).toEqual({ error: expect.stringContaining('use write') });
    expect(applyEdit(SRC, { old_text: 'f()', new_text: 'f()' })).toEqual({ error: expect.stringContaining('same') });
  });
  test('not found points at where the first line appears', () => {
    const r = applyEdit(SRC, { old_text: 'if (a) {\n  return 9;', new_text: '' });
    expect('error' in r && r.error).toContain('not found');
    expect('error' in r && r.error).toContain('first line appears at line 2');
  });
  test('not found without a pointer when the first line is nowhere', () => {
    const r = applyEdit(SRC, { old_text: 'nothing like this', new_text: 'x' });
    expect('error' in r && r.error).toContain('not found');
    expect('error' in r && r.error).not.toContain('appears');
  });
});
