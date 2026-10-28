import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrompt } from '../src/core/loop/run.ts';
import { FAUX_MODEL } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse, type FauxStep } from '../src/core/providers/faux.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { readTool } from '../src/core/tools/read.ts';
import { findStuck, stuckReminder } from '../src/core/trust/stuck.ts';
import type { EventOf, SessionEvent } from '../src/core/types.ts';

const cwd = mkdtempSync(join(tmpdir(), 'cedia-stuck-'));
writeFileSync(join(cwd, 'a.txt'), 'alpha\n');
writeFileSync(join(cwd, 'b.txt'), 'beta\n');

// A log of calls and their results, each call its own turn.
function events(calls: { tool: string; input: Record<string, unknown>; out: string; isError?: boolean }[]): SessionEvent[] {
  return calls.flatMap((c, i) => [
    { kind: 'assistant', blocks: [{ type: 'tool_use', id: `c${i}`, name: c.tool, input: c.input }] },
    { kind: 'tool_result', callId: `c${i}`, status: c.isError ? 'failed' : 'completed', output: { text: c.out, isError: c.isError ?? false } },
  ]) as unknown as SessionEvent[];
}
const read = (path: string, out = 'x') => ({ tool: 'read', input: { path }, out });

describe('findStuck', () => {
  test('the same call with the same result 4 times in a row', () => {
    expect(findStuck(events([read('a'), read('a'), read('a')]))).toBeUndefined();
    expect(findStuck(events([read('a'), read('a'), read('a'), read('a')]))).toEqual({ kind: 'same-call', tools: ['read'], times: 4 });
  });

  test('a repeat whose result changed is not stuck: a test run again after a fix, a poll that moves', () => {
    expect(findStuck(events([read('a', '1'), read('a', '2'), read('a', '3'), read('a', '4')]))).toBeUndefined();
  });

  test('the same tool failing with the same error 3 times, whatever its input', () => {
    const fail = (old: string) => ({ tool: 'edit', input: { path: 'a', old_text: old }, out: 'old_text not found', isError: true });
    expect(findStuck(events([fail('x'), fail('y')]))).toBeUndefined();
    expect(findStuck(events([fail('x'), fail('y'), fail('z')]))).toEqual({ kind: 'same-error', tools: ['edit'], times: 3 });
    // A different error in between breaks the run of them.
    expect(findStuck(events([fail('x'), { ...fail('y'), out: 'old_text matches 2 places' }, fail('z')]))).toBeUndefined();
  });

  test('two calls taking turns 3 times with nothing new from either', () => {
    const ab = [read('a'), read('b'), read('a'), read('b'), read('a')];
    expect(findStuck(events(ab))).toBeUndefined();
    expect(findStuck(events([...ab, read('b')]))).toEqual({ kind: 'alternating', tools: ['read', 'read'], times: 3 });
  });

  test('waiting is meant to repeat, and a call that never ran does not count', () => {
    const wait = { tool: 'sleep', input: { ms: 1000 }, out: 'slept' };
    expect(findStuck(events([wait, wait, wait, wait, wait]))).toBeUndefined();
    const notRun = events([read('a'), read('a'), read('a'), read('a')]).map((e) => (e.kind === 'tool_result' && e.callId === 'c3' ? { ...e, status: 'not_started' } : e)) as SessionEvent[];
    expect(findStuck(notRun)).toBeUndefined();
  });
});

describe('stuck guard in the loop', () => {
  const missing = (id: string) => ({ blocks: [toolUse(id, 'read', { path: 'missing.txt' })] });
  function setup(steps: FauxStep[]) {
    const log = SessionLog.create();
    return { log, run: () => runPrompt({ log, provider: fauxProvider(steps), model: FAUX_MODEL, tools: [readTool, bashTool], system: 'sys', cwd, retry: { sleep: async () => {} } }, 'read missing.txt') };
  }
  const reminders = (events: SessionEvent[]) => events.filter((e): e is EventOf<'reminder'> => e.kind === 'reminder').map((r) => r.text);

  test('one reminder, then a run that changes approach goes on to its report', async () => {
    const { log, run } = setup([missing('c1'), missing('c2'), missing('c3'), { blocks: [toolUse('c4', 'read', { path: 'a.txt' })] }, { blocks: [text('missing.txt does not exist; a.txt says alpha')] }]);
    const r = await run();
    expect(r.subtype).toBe('success');
    expect(reminders(log.events)).toEqual([stuckReminder({ kind: 'same-error', tools: ['read'], times: 3 })]);
    expect(lintSession(log.events)).toEqual([]);
  });

  test('a run that repeats itself again after the reminder ends error_stuck, every call answered', async () => {
    const { log, run } = setup([missing('c1'), missing('c2'), missing('c3'), missing('c4'), missing('c5'), missing('c6'), { blocks: [text('never reached')] }]);
    const r = await run();
    expect(r.subtype).toBe('error_stuck');
    expect(r.numTurns).toBe(6);
    expect(r.result).toContain('kept repeating itself');
    expect(reminders(log.events)).toHaveLength(1);
    expect(lintSession(log.events)).toEqual([]);
  });
});
