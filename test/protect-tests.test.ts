import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, type Policy } from '../src/core/safety/policy.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { editTool, writeTool } from '../src/core/tools/edit.ts';
import { readTool } from '../src/core/tools/read.ts';
import { existingTests, leavesTestsAlone, PROTECTED_TEST_REASON } from '../src/core/trust/tests.ts';
import type { SessionEvent } from '../src/core/types.ts';

describe('tests a task leaves alone', () => {
  test('the prompt says so, in the ways tasks put it', () => {
    for (const p of [
      'Fix memo.ts; do not change the existing tests, and add a test for each bug you fix.',
      'Do not change the tests.',
      "Don't modify any tests.",
      'Leave the existing tests alone and add your own.',
      'แก้บั๊กใน memo.ts แต่อย่าแก้เทสต์เดิม',
    ])
      expect(leavesTestsAlone(p)).toBe(true);
    for (const p of ['Fix the failing tests.', 'Add tests for the parser.', "Don't change the tests unless one is wrong.", 'Do not change the API; update the tests to match.'])
      expect(leavesTestsAlone(p)).toBe(false);
  });

  test('the test files already there, outside dependencies and dot directories', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-tests-'));
    for (const d of ['src', 'test', 'node_modules/x', '.git']) mkdirSync(join(cwd, d), { recursive: true });
    for (const f of ['memo.ts', 'memo.test.ts', 'src/a.spec.js', 'test/helpers.ts', 'test_b.py', 'node_modules/x/x.test.js', '.git/c.test.ts']) writeFileSync(join(cwd, f), '');
    expect(existingTests(cwd)).toEqual(['memo.test.ts', 'src/a.spec.js', 'test/helpers.ts', 'test_b.py']);
  });

  test('the policy refuses every way of changing one, and lets a new test file and reads through', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-protect-'));
    const policy: Policy = { mode: 'workspace', allow: [], deny: [], protect: { paths: ['memo.test.ts'], reason: PROTECTED_TEST_REASON } };
    const denied = { decision: 'deny' as const, rule: 'protected-test', reason: `memo.test.ts: ${PROTECTED_TEST_REASON}` };
    expect(decide(policy, editTool, { path: 'memo.test.ts', edits: [] }, cwd)).toEqual(denied);
    expect(decide(policy, writeTool, { path: join(cwd, 'memo.test.ts'), content: '' }, cwd)).toEqual(denied);
    for (const command of ['echo x >> memo.test.ts', "sed -i 's/a/b/' memo.test.ts", 'cp other.ts memo.test.ts'])
      expect(decide(policy, bashTool, { command }, cwd).rule).toBe('protected-test');
    expect(decide(policy, writeTool, { path: 'memo.more.test.ts', content: '' }, cwd).rule).toBe('mode:workspace');
    expect(decide(policy, bashTool, { command: 'cat memo.test.ts' }, cwd).decision).toBe('allow');
    expect(decide(policy, readTool, { path: 'memo.test.ts' }, cwd).decision).toBe('allow');
  });

  test('a run whose task says so cannot change them, and says how many it holds (offline, faux)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-protect-e2e-'));
    writeFileSync(join(dir, 'memo.test.ts'), 'test("a", () => {});\n');
    const tool = (id: string, name: string, input: object) => ({ blocks: [{ type: 'tool_use', id, name, input }] });
    const script = [
      tool('c1', 'write', { path: 'memo.test.ts', content: 'changed\n' }),
      tool('c2', 'bash', { command: 'echo more >> memo.test.ts' }),
      tool('c3', 'write', { path: 'memo.fix.test.ts', content: 'test("b", () => {});\n' }),
      tool('c4', 'bash', { command: 'test -s memo.fix.test.ts' }),
      { blocks: [{ type: 'text', text: 'done' }] },
    ];
    writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
    const home = join(dir, '.home');
    const run = (prompt: string) =>
      Bun.spawnSync([join(import.meta.dir, '..', 'bin', 'cedia'), '-m', 'faux', '--cwd', dir, '-p', prompt, '--permission', 'workspace', '--sandbox', 'off', '--check', 'test -s memo.fix.test.ts'], {
        env: { ...process.env, CEDIA_FAUX_SCRIPT: join(dir, 'script.json'), CEDIA_HOME: home },
      });
    const r = run('Fix memo.ts. Do not change the existing tests; add tests for what you fix.');
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toContain('the task leaves the existing tests alone, so 1 test file may not change');
    expect(readFileSync(join(dir, 'memo.test.ts'), 'utf8')).toBe('test("a", () => {});\n');
    expect(readFileSync(join(dir, 'memo.fix.test.ts'), 'utf8')).toBe('test("b", () => {});\n');
    const sessions = join(home, 'sessions');
    const [project] = readdirSync(sessions);
    const [file] = readdirSync(join(sessions, project!));
    const results = SessionLog.load(join(sessions, project!, file!)).events.filter((e): e is Extract<SessionEvent, { kind: 'tool_result' }> => e.kind === 'tool_result');
    expect(results.map((e) => e.status)).toEqual(['denied', 'denied', 'completed', 'completed']);
  });
});
