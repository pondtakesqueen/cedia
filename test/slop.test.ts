import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectChecks } from '../src/core/config.ts';
import { runPrompt } from '../src/core/loop/run.ts';
import { FAUX_MODEL } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse } from '../src/core/providers/faux.ts';
import { openSnapshots } from '../src/core/safety/snapshot.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { CORE_TOOLS } from '../src/core/tools/index.ts';
import { changesFromPatch, findSlop, type FileChange } from '../src/core/trust/slop.ts';

const change = (path: string, added: string[], removed: string[] = [], deleted = false): FileChange => ({ path, added, removed, deleted });
const rules = (c: FileChange[]) => findSlop(c).map((f) => `${f.rule} ${f.path}`);

describe('findSlop', () => {
  test('tests deleted, weakened or skipped', () => {
    expect(rules([change('src/a.test.ts', [], [], true)])).toEqual(['test-deleted src/a.test.ts']);
    expect(rules([change('tests/test_x.py', ['    pass'], ['    assert x == 1', '    assert y == 2'])])).toEqual(['test-weakened tests/test_x.py']);
    expect(rules([change('a.test.ts', ["test.skip('x', () => {})"]), change('b_test.go', ['\tt.Skip("flaky")'])])).toEqual(['test-skipped a.test.ts', 'test-skipped b_test.go']);
    expect(rules([change('a.test.ts', ["  expect(f(2)).toBe(4);"], ["  expect(f(1)).toBe(2);"])])).toEqual([]); // rewritten, not weakened
    expect(rules([change('src/a.ts', [], [], true)])).toEqual([]); // deleting source is not test slop
  });

  test('silenced checks, swallowed errors, type escapes and stubs', () => {
    expect(
      rules([
        change('src/a.ts', ['// @ts-ignore', '/* eslint-disable */', 'try { f() } catch {}', 'const x = y as any;', "throw new Error('not implemented');"]),
        change('app.py', ['x = f()  # type: ignore', 'except Exception:  pass', 'raise NotImplementedError']),
      ]),
    ).toEqual([
      'suppression src/a.ts',
      'suppression src/a.ts',
      'swallowed-error src/a.ts',
      'type-escape src/a.ts',
      'stub src/a.ts',
      'suppression app.py',
      'swallowed-error app.py',
      'stub app.py',
    ]);
  });

  test('ordinary code is not flagged', () => {
    expect(
      rules([
        change('src/a.ts', ['try { f() } catch (e) { log(e); throw e; }', 'const company = "acme";', 'type Many = string[];', 'it.each(cases)("works", run);']),
        change('notes.md', ['as any reader knows, catch {} is bad']),
      ]),
    ).toEqual([]);
  });

  test('a type escape in a comment, a string or a regex is prose, not code', () => {
    expect(
      rules([
        change('src/a.ts', [
          '// The rule matches: any key, as any reader can see',
          ' * note: any value is fine here',
          'const n = count(x); // returns: any number of lines',
          "const msg = 'pass as any string';",
          "const re = /\\bas any\\b|:\\s*any\\b/;",
          "  { rule: 'type-escape', re: /\\bas any\\b|<any>/, files: /\\.ts$/ },",
        ]),
      ]),
    ).toEqual([]);
    expect(rules([change('src/a.ts', ['const x = f(\'//\') as any;', 'let y: any = 1; // fine', 'const half = a / 2 as any;'])])).toEqual([
      'type-escape src/a.ts',
      'type-escape src/a.ts',
      'type-escape src/a.ts',
    ]);
  });

  test("a detector's own patterns, in regex literals and strings, are not the shortcuts they name", () => {
    const own = readFileSync(join(import.meta.dir, '../src/core/trust/slop.ts'), 'utf8').split('\n');
    expect(rules([change('src/core/trust/slop.ts', own)])).toEqual([]);
    expect(rules([change('src/a.ts', ["const SKIP = /\\.(skip|only)\\s*\\(/;", "const re = /catch\\s*\\{\\s*\\}/;", "const note = 'add // @ts-ignore';"])])).toEqual([]);
    // The real ones still count: a suppression is a comment, a skip and a swallowed error are code.
    expect(rules([change('a.test.ts', ["test.skip('x', () => {}); // see /re/"]), change('src/b.ts', ['f(); // @ts-ignore', "try { g('}') } catch {}"])])).toEqual([
      'test-skipped a.test.ts',
      'suppression src/b.ts',
      'swallowed-error src/b.ts',
    ]);
  });
});

test('changesFromPatch reads a -U0 git patch', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/t.test.ts b/t.test.ts',
    'deleted file mode 100644',
    '--- a/t.test.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    "-test('x', () => {})",
  ].join('\n');
  expect(changesFromPatch(patch)).toEqual([
    { path: 'src/a.ts', added: ['new'], removed: ['old'], deleted: false },
    { path: 't.test.ts', added: [], removed: ["test('x', () => {})"], deleted: true },
  ]);
});

describe('in the loop', () => {
  const steps = () => [
    { blocks: [toolUse('c1', 'write', { path: 'a.ts', content: '// @ts-ignore\nexport const x: number = "1";\n' })] },
    { blocks: [text('done')] },
    { blocks: [text('kept it: the type is wrong upstream')] },
  ];

  test('one reminder names the finding; the second claim ends the run with it in the evidence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-slop-'));
    const log = SessionLog.create();
    const res = await runPrompt({ log, provider: fauxProvider(steps()), model: FAUX_MODEL, tools: CORE_TOOLS, system: 's', cwd, permission: { mode: 'workspace', allow: [], deny: [] } }, 'go');
    expect(res.subtype).toBe('success');
    const reminders = log.events.filter((e) => e.kind === 'reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.kind === 'reminder' && reminders[0]!.text).toContain('suppression a.ts: // @ts-ignore');
    expect(res.evidence?.flags).toEqual(['suppression a.ts: // @ts-ignore']);
    expect(lintSession(log.events)).toEqual([]);
  });

  test('with snapshots it reads the real diff, bash included; unlock turns it off', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-slop-'));
    writeFileSync(join(cwd, 'x.test.ts'), "test('a', () => expect(1).toBe(1));\n");
    const home = mkdtempSync(join(tmpdir(), 'cedia-slophome-'));
    const snapshots = openSnapshots(cwd, join(home, 'snap'))!;
    const script = [{ blocks: [toolUse('c1', 'bash', { command: 'rm x.test.ts' })] }, { blocks: [text('done')] }, { blocks: [text('done')] }];
    const log = SessionLog.create();
    const res = await runPrompt({ log, provider: fauxProvider(script), model: FAUX_MODEL, tools: CORE_TOOLS, system: 's', cwd, snapshots, permission: { mode: 'workspace', allow: [], deny: [] } }, 'go');
    expect(res.evidence?.flags).toEqual(['test-deleted x.test.ts']);

    const off = SessionLog.create();
    const cwd2 = mkdtempSync(join(tmpdir(), 'cedia-slop-'));
    const quiet = await runPrompt({ log: off, provider: fauxProvider(steps()), model: FAUX_MODEL, tools: CORE_TOOLS, system: 's', cwd: cwd2, permission: { mode: 'workspace', allow: [], deny: [], unlock: ['slop-check'] } }, 'go');
    expect(quiet.subtype).toBe('success');
    expect(off.events.some((e) => e.kind === 'reminder')).toBe(false);
    expect(quiet.evidence?.flags).toBeUndefined();
  });

  test('detected checks remind once but never refuse', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-soft-'));
    const script = [{ blocks: [toolUse('c1', 'write', { path: 'b.txt', content: 'x\n' })] }, { blocks: [text('done')] }, { blocks: [text('done')] }];
    const opts = { model: FAUX_MODEL, tools: CORE_TOOLS, system: 's', cwd, checks: ['bun test'], permission: { mode: 'workspace' as const, allow: [], deny: [] } };
    expect((await runPrompt({ ...opts, log: SessionLog.create(), provider: fauxProvider(script), softChecks: true }, 'go')).subtype).toBe('success');
    expect((await runPrompt({ ...opts, log: SessionLog.create(), provider: fauxProvider(script) }, 'go')).subtype).toBe('error_unverified_claim');
  });
});

test('detectChecks finds the repo test command', () => {
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), 'cedia-detect-'));
    for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
    return d;
  };
  expect(detectChecks(dir({ 'package.json': '{"scripts":{"test":"vitest run"}}', 'pnpm-lock.yaml': '' }))).toEqual(['pnpm test']);
  expect(detectChecks(dir({ 'package.json': '{"scripts":{"test":"bun test"}}', 'bun.lock': '' }))).toEqual(['bun run test']);
  expect(detectChecks(dir({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' }))).toEqual([]);
  expect(detectChecks(dir({ 'Cargo.toml': '' }))).toEqual(['cargo test']);
  expect(detectChecks(dir({ 'go.mod': '' }))).toEqual(['go test ./...']);
  expect(detectChecks(dir({ Makefile: 'build:\n\tcc x.c\ntest:\n\t./run\n' }))).toEqual(['make test']);
  expect(detectChecks(dir({ 'README.md': '' }))).toEqual([]);
});
