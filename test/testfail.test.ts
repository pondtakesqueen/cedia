import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool } from '../src/core/tools/bash.ts';
import { isTestCommand, summarizeTestFailures } from '../src/core/tools/testfail.ts';

const pytest = ['best suite', ...Array.from({ length: 400 }, (_, i) => `test_${i} ok`), 'FAILED test_login - AssertionError: expected home, got login', 'Traceback (most recent call last):', '  File "t.py", line 3, in test_login', '1 failed, 400 passed in 2s'].join('\n');
const goout = ['ok  pkg/one 0.1s', '--- FAIL: TestParse (0.00s)', '    p_test.go:12: got 2, want 3', 'FAIL pkg/two 0.2s', 'ok  pkg/three 0.1s'].join('\n');

describe('test failure summaries', () => {
  test('only test-runner commands qualify', () => {
    for (const c of ['pytest -q', 'go test ./...', 'bun test', 'npm test', 'npx vitest run', 'cargo test', 'bun test test/a.test.ts']) expect(isTestCommand(c)).toBe(true);
    for (const c of ['ls', 'git status', 'cat big.log', 'python script.py', 'npm run build']) expect(isTestCommand(c)).toBe(false);
  });

  test('failures and their context ride along; the passing middle does not', () => {
    const s = summarizeTestFailures('pytest -q', `${pytest}\n${'filler line\n'.repeat(600)}`)!;
    expect(s).toContain('FAILED test_login');
    expect(s).toContain('Traceback');
    expect(s).toContain('1 failed, 400 passed');
    expect(s).not.toContain('test_200 ok');
    expect(s).toContain('lines not shown');
    expect(summarizeTestFailures('go test ./...', goout.repeat(400))).toContain('FAIL: TestParse');
  });

  test('a long bun run test keeps the failure lines', async () => {
    expect(isTestCommand('bun run test')).toBe(true);
    expect(isTestCommand('bun run test -- test/a.test.ts')).toBe(true);
    expect(isTestCommand('bun run test -- --bail')).toBe(true);
    const fail = 'FAILED test_login - AssertionError: expected home, got login';
    const text = `${'ok line\n'.repeat(2500)}${fail}\n${'ok tail\n'.repeat(400)}`;
    expect(text.length).toBeGreaterThan(8_000);
    expect(text.indexOf(fail)).toBeGreaterThan(4_000);
    expect(text.length - (text.indexOf(fail) + fail.length)).toBeGreaterThan(4_000);
    const s = summarizeTestFailures('bun run test', text)!;
    expect(s).toContain(fail);
    expect(s).toContain('lines not shown');
    expect((s.match(/ok line/g) ?? []).length).toBeLessThan(10);

    const cwd = mkdtempSync(join(tmpdir(), 'cedia-testfail-'));
    let spilled = '';
    const spill = (full: string) => {
      spilled = join(cwd, 'spill.txt');
      writeFileSync(spilled, full);
      return spilled;
    };
    const command = `bun run test; python3 -c "print('ok line\\n' * 2500); print('${fail}'); print('ok tail\\n' * 400)"`;
    const r = await bashTool.run({ command }, { cwd, signal: AbortSignal.timeout(30_000), spill });
    expect(r.text).toContain(fail);
    expect(r.text).toContain(spilled);
    expect((r.text.match(/ok line/g) ?? []).length).toBeLessThan(10);
  });

  test('short output, passing runs and other commands fall back to undefined', () => {
    expect(summarizeTestFailures('pytest -q', 'short')).toBeUndefined();
    expect(summarizeTestFailures('ls', 'x'.repeat(20_000))).toBeUndefined();
    expect(summarizeTestFailures('bun test', '10 pass\n0 fail\n')).toBeUndefined();
  });

  test('a long failing check reaches the model as failures plus the spill path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-testfail-'));
    let spilled = '';
    const spill = (text: string) => {
      spilled = join(cwd, 'spill.txt');
      writeFileSync(spilled, text);
      return spilled;
    };
    const big = `python3 -c "print('ok\\n' * 3000); print('FAILED test_login'); print('AssertionError: boom')"`;
    const r = await bashTool.run({ command: `${big} # pytest run` }, { cwd, signal: AbortSignal.timeout(30_000), spill });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('FAILED test_login');
    // Only the failure's neighborhood and the tail ride along, not the 3000 passing lines.
    expect((r.text.match(/\bok\b/g) ?? []).length).toBeLessThan(20);
    expect(r.text).toContain(spilled);
    expect((r as { spillPath?: string }).spillPath).toBe(spilled);
    expect(readFileSync(spilled, 'utf8')).toContain('FAILED test_login');
  });
});
