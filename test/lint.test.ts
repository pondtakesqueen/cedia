import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrompt } from '../src/core/loop/run.ts';
import { FAUX_MODEL } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse } from '../src/core/providers/faux.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { CORE_TOOLS } from '../src/core/tools/index.ts';
import type { SessionEvent } from '../src/core/types.ts';

const cwd = mkdtempSync(join(tmpdir(), 'cedia-lint-'));
writeFileSync(join(cwd, 'a.txt'), 'a\n');

async function goodLog(): Promise<SessionEvent[]> {
  const log = SessionLog.create();
  const provider = fauxProvider([
    { blocks: [toolUse('c1', 'read', { path: 'a.txt' }), toolUse('c2', 'write', { path: 'b.txt', content: 'b' })] },
    { blocks: [text('ok')] },
  ]);
  await runPrompt({ log, provider, model: FAUX_MODEL, tools: CORE_TOOLS, system: 's', cwd, permission: { mode: 'workspace', allow: [], deny: [] } }, 'go');
  return structuredClone(log.events);
}

// Rewrites one event and re-links parent ids, so only the rule under test fires.
function mutate(events: SessionEvent[], f: (es: SessionEvent[]) => SessionEvent[]): SessionEvent[] {
  return f(events).map((e, i, all) => ({ ...e, parentId: i === 0 ? null : all[i - 1]!.id }));
}

const rules = (events: SessionEvent[]) => [...new Set(lintSession(events).map((f) => f.rule))];

describe('session linter', () => {
  test('a real faux session is clean', async () => {
    expect(lintSession(await goodLog())).toEqual([]);
  });

  test('a run\'s result may follow the last turn_end, and nowhere else', async () => {
    const good = await goodLog();
    const result = { id: 'r1', parentId: null, at: '', kind: 'result', result: { type: 'result', subtype: 'success', sessionId: 's', numTurns: 2, usage: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: 0, cacheHitRatio: 0, result: 'ok' } } as SessionEvent;
    expect(rules(mutate(good, (es) => [...es, result]))).toEqual([]);
    expect(rules(mutate(good, (es) => [...es.slice(0, 3), result, ...es.slice(3)]))).toEqual(['turn-end']);
  });

  test('a missing tool_result', async () => {
    expect(rules(mutate(await goodLog(), (es) => es.filter((e) => !(e.kind === 'tool_result' && e.callId === 'c1'))))).toEqual(['tool-pairing']);
  });

  test('an intent without an allow decision, and a denied call that ran', async () => {
    const noPermission = mutate(await goodLog(), (es) => es.filter((e) => !(e.kind === 'permission' && e.callId === 'c1')));
    expect(rules(noPermission)).toEqual(['permission-order']);
    const deniedButRan = mutate(await goodLog(), (es) => es.map((e) => (e.kind === 'permission' && e.callId === 'c2' ? { ...e, decision: 'deny' as const } : e)));
    expect(rules(deniedButRan)).toEqual(['permission-order']);
  });

  test('a header value in the log', async () => {
    const leaked = mutate(await goodLog(), (es) => es.map((e) => (e.kind === 'request' ? { ...e, headers: { authorization: 'Bearer sk-live' } } : e)));
    expect(rules(leaked)).toEqual(['no-header-values']);
  });

  test('a system prompt change mid-session', async () => {
    let n = 0;
    const changed = mutate(await goodLog(), (es) => es.map((e) => (e.kind === 'request' && n++ === 1 ? { ...e, systemHash: '0000000000000000' } : e)));
    expect(rules(changed)).toEqual(['prefix-stable']);
  });

  test('a request without an attempt, a broken parent chain, no turn_end', async () => {
    expect(rules(mutate(await goodLog(), (es) => es.filter((e) => e.kind !== 'attempt')))).toEqual(['request-attempt']);
    const events = await goodLog();
    events[3] = { ...events[3]!, parentId: null };
    expect(rules(events)).toEqual(['parent-chain']);
    expect(rules((await goodLog()).slice(0, -1))).toEqual(['turn-end']);
  });
});

describe('declared check matching', () => {
  test('the whole command, give or take whitespace, 2>&1 and a cd to the working directory', async () => {
    const { matchCheck } = await import('../src/core/trust/ledger.ts');
    const checks = ['node test.js'];
    expect(matchCheck('node  test.js 2>&1', checks, '/w')).toBe('node test.js');
    expect(matchCheck('cd /w && node test.js', checks, '/w')).toBe('node test.js');
    expect(matchCheck('cd "/w/" && node test.js', checks, '/w')).toBe('node test.js');
    expect(matchCheck('cd . && node test.js', checks, '/w')).toBe('node test.js');
    expect(matchCheck('cd /elsewhere && node test.js', checks, '/w')).toBeUndefined();
    expect(matchCheck('node test.js | tail', checks, '/w')).toBeUndefined();
    expect(matchCheck('node test.js; echo ok', checks, '/w')).toBeUndefined();
  });
});
