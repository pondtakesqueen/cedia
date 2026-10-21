import { describe, expect, test } from 'bun:test';
import { evidence, ledgerEntries, matchCheck, verified, type SessionEvent } from './ledger.ts';

const cwd = '/work/repo';
let n = 0;
const bash = (command: string, exitCode = 0, status: 'completed' | 'failed' | 'denied' | 'not_started' = exitCode ? 'failed' : 'completed'): SessionEvent[] => {
  const callId = `c${++n}`;
  return [
    { kind: 'tool_intent', callId, tool: 'bash', input: { command } },
    { kind: 'tool_result', callId, status, output: { isError: exitCode !== 0, exitCode } },
  ];
};
const edit = (path: string, status: 'completed' | 'failed' = 'completed', tool = 'edit'): SessionEvent[] => {
  const callId = `c${++n}`;
  return [
    { kind: 'tool_intent', callId, tool, input: { path } },
    { kind: 'tool_result', callId, status, output: { isError: status !== 'completed' } },
  ];
};

describe('matchCheck', () => {
  test('the whole command must be the check', () => {
    expect(matchCheck('bun test', ['bun test'])).toBe('bun test');
    expect(matchCheck('  bun   test  ', ['bun test'])).toBe('bun test');
    expect(matchCheck('bun test 2>&1', ['bun test'])).toBe('bun test');
    expect(matchCheck('bun test', ['bun  test 2>&1'])).toBe('bun  test 2>&1');
    expect(matchCheck('bun test | tail', ['bun test'])).toBeUndefined();
    expect(matchCheck('bun test && echo ok', ['bun test'])).toBeUndefined();
    expect(matchCheck('bun test src', ['bun test'])).toBeUndefined();
    expect(matchCheck('make lint', ['bun test', 'make lint'])).toBe('make lint');
  });

  test('a leading cd to the working directory is fine; anywhere else is not', () => {
    expect(matchCheck('cd /work/repo && bun test', ['bun test'], cwd)).toBe('bun test');
    expect(matchCheck('cd "/work/repo" && bun test 2>&1', ['bun test'], cwd)).toBe('bun test');
    expect(matchCheck('cd . && bun test', ['bun test'], cwd)).toBe('bun test');
    expect(matchCheck('cd /work/repo/sub && bun test', ['bun test'], cwd)).toBeUndefined();
    expect(matchCheck('cd /work/repo && bun test', ['bun test'])).toBeUndefined(); // no cwd given
  });
});

describe('ledgerEntries', () => {
  test('edits, writing commands and checks, in log order, with their positions', () => {
    const events: SessionEvent[] = [{ kind: 'request' }, ...edit('a.ts'), ...bash('ls -la'), ...bash('npm install'), ...bash('bun test', 1), ...edit('b.ts', 'completed', 'write'), ...bash('bun test')];
    expect(ledgerEntries(events, ['bun test'])).toEqual([
      { kind: 'write', at: 2, tool: 'edit', path: 'a.ts' },
      { kind: 'write', at: 6, tool: 'bash', command: 'npm install' },
      { kind: 'check', at: 8, command: 'bun test', exitCode: 1 },
      { kind: 'write', at: 10, tool: 'write', path: 'b.ts' },
      { kind: 'check', at: 12, command: 'bun test', exitCode: 0 },
    ]);
  });

  test('denied, not started and failed edits are not writes; a result without an intent is ignored', () => {
    const events: SessionEvent[] = [
      ...edit('a.ts', 'failed'),
      ...bash('rm -rf build', 0, 'denied'),
      ...bash('make', 0, 'not_started'),
      { kind: 'tool_result', callId: 'ghost', status: 'completed', output: { isError: false } },
    ];
    expect(ledgerEntries(events, [])).toEqual([]);
  });

  test('an intent from before the last request does not pair with a later result', () => {
    const [intent, result] = edit('a.ts');
    expect(ledgerEntries([intent!, { kind: 'request' }, result!], [])).toEqual([]);
  });

  test('snapshots name the files a call changed, even bash; an empty list means nothing changed', () => {
    const write = bash('sed -i s/a/b/ x.ts y.ts');
    const noop = bash('touch-nothing');
    const callId = (e: SessionEvent) => (e.kind === 'tool_intent' ? e.callId : '');
    const events: SessionEvent[] = [...write, { kind: 'snapshot', callId: callId(write[0]!), changed: ['x.ts', 'y.ts'] }, ...noop, { kind: 'snapshot', callId: callId(noop[0]!), changed: [] }];
    expect(ledgerEntries(events, [])).toEqual([
      { kind: 'write', at: 1, tool: 'bash', path: 'x.ts' },
      { kind: 'write', at: 1, tool: 'bash', path: 'y.ts' },
    ]);
  });

  test('a check is never a write, even with a snapshot; a missing exit code comes from isError', () => {
    const check = bash('bun test');
    const callId = check[0]!.kind === 'tool_intent' ? check[0]!.callId : '';
    const noCode: SessionEvent[] = [
      { kind: 'tool_intent', callId: 'k', tool: 'bash', input: { command: 'bun test' } },
      { kind: 'tool_result', callId: 'k', status: 'failed', output: { isError: true } },
    ];
    expect(ledgerEntries([...check, { kind: 'snapshot', callId, changed: ['.cache/x'] }, ...noCode], ['bun test'])).toEqual([
      { kind: 'check', at: 1, command: 'bun test', exitCode: 0 },
      { kind: 'check', at: 4, command: 'bun test', exitCode: 1 },
    ]);
  });
});

describe('evidence and the done gate', () => {
  const w = (at: number, path?: string, command?: string) => ({ kind: 'write' as const, at, tool: path ? 'edit' : 'bash', ...(path ? { path } : { command }) });
  const c = (at: number, exitCode: number) => ({ kind: 'check' as const, at, command: 'bun test', exitCode });

  test('evidence lists changes, checks and what no passing check covers', () => {
    expect(evidence([w(1, 'a.ts'), c(2, 0), w(3, 'b.ts'), w(4, undefined, 'npm i'), w(5, 'b.ts'), c(6, 1)])).toEqual({
      changed: ['a.ts', 'b.ts', 'bash: npm i'],
      checks: [{ command: 'bun test', exitCode: 0 }, { command: 'bun test', exitCode: 1 }],
      unverified: ['b.ts', 'bash: npm i'],
    });
    expect(evidence([w(1, 'a.ts'), c(2, 1)]).unverified).toEqual(['a.ts']);
    expect(evidence([])).toEqual({ changed: [], checks: [], unverified: [] });
  });

  test('verified needs a passing check after the last write', () => {
    expect(verified([w(1, 'a.ts'), c(2, 0)], ['bun test'])).toBe(true);
    expect(verified([c(1, 0), w(2, 'a.ts')], ['bun test'])).toBe(false);
    expect(verified([w(1, 'a.ts'), c(2, 0), w(3, 'a.ts'), c(4, 1)], ['bun test'])).toBe(false);
    expect(verified([w(1, 'a.ts')], [])).toBe(true);
    expect(verified([c(1, 1)], ['bun test'])).toBe(true);
    expect(verified([], ['bun test'])).toBe(true);
  });
});
