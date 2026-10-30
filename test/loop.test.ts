import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTINUE_AFTER_LIMIT, EMPTY_REPLY, escalationTarget, nearCheck, PLAN_FIRST, runPrompt, spillOutput, type RunOptions } from '../src/core/loop/run.ts';
import { FAUX_MODEL, resolveModel } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse, type FauxStep } from '../src/core/providers/faux.ts';
import { decide } from '../src/core/safety/policy.ts';
import { secretPaths } from '../src/core/safety/secrets.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { CORE_TOOLS } from '../src/core/tools/index.ts';
import { readTool } from '../src/core/tools/read.ts';
import { MAX_OUTPUT_CHARS, preview } from '../src/core/tools/registry.ts';
import { EFFORTS, type EventOf, type SessionEvent, type WireRequest } from '../src/core/types.ts';
import { hash } from '../src/core/hash.ts';

const cwd = mkdtempSync(join(tmpdir(), 'cedia-loop-'));
writeFileSync(join(cwd, 'a.txt'), 'alpha\n');

function setup(steps: FauxStep[], extra: Partial<RunOptions> = {}) {
  const log = SessionLog.create();
  const provider = fauxProvider(steps);
  const sleeps: number[] = [];
  const opts: RunOptions = {
    log,
    provider,
    model: FAUX_MODEL,
    tools: [readTool, bashTool],
    system: 'sys',
    cwd,
    retry: { sleep: async (ms) => void sleeps.push(ms) },
    ...extra,
  };
  return { log, provider, opts, sleeps };
}

const kinds = (events: SessionEvent[]) => events.map((e) => e.kind);
const of = <K extends SessionEvent['kind']>(events: SessionEvent[], k: K) => events.filter((e): e is EventOf<K> => e.kind === k);

// The invariant every log must keep: each tool_use gets exactly one tool_result.
function expectPaired(events: SessionEvent[]) {
  const uses = of(events, 'assistant').flatMap((a) => a.blocks.flatMap((b) => (b.type === 'tool_use' ? [b.callId ?? b.id] : [])));
  const results = of(events, 'tool_result').map((r) => r.callId);
  expect(results.sort()).toEqual(uses.sort());
  expect(lintSession(events)).toEqual([]);
}

describe('long bash output', () => {
  test('goes to a redacted file whole, and the result shows its start, its end and the path', async () => {
    const key = `sk-ant-${'k1'.repeat(20)}`;
    const lines = Array.from({ length: 20_000 }, (_, i) => (i === 10_000 ? `FAILED middle_test ${key}` : `line ${i}`));
    writeFileSync(join(cwd, 'big.txt'), lines.join('\n') + '\n');
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'bash', { command: 'cat big.txt' })] }, { blocks: [text('read it')] }]);
    await runPrompt(opts, 'show big.txt');
    const result = of(log.events, 'tool_result')[0]!;
    const path = result.output.spillPath!;
    expect(path).toContain(log.id);
    expect(result.output.text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(result.output.text).toContain(`is in ${path}`);
    const shown = result.output.text;
    expect([shown.startsWith('line 0\n'), shown.endsWith('line 19999\n\n[exit 0]'), shown.includes('middle_test')]).toEqual([true, true, false]);
    const whole = readFileSync(path, 'utf8');
    expect(whole).toContain('FAILED middle_test [cedia:redacted]');
    expect(whole).not.toContain(key);
    expect(whole.split('\n')).toHaveLength(20_002);
    expectPaired(log.events);
  });

  test('the file is one a later read call may open', async () => {
    const path = spillOutput('s1', 'c/1', 'whole output\n', mkdtempSync(join(tmpdir(), 'cedia-spill-')))!;
    expect(path).toEndWith('/s1/c_1.txt');
    const d = decide({ mode: 'read-only', allow: [], deny: [], secrets: secretPaths(join(tmpdir(), 'no-cedia-home')) }, readTool, { path }, cwd);
    expect(d.decision).toBe('allow');
    expect((await readTool.run({ path }, { cwd, signal: new AbortController().signal })).text).toContain('whole output');
  });

  test('the preview states exactly how much it leaves out', () => {
    for (const len of [30_001, 45_678, 1_000_000]) {
      const text = 'x'.repeat(len);
      const shown = preview(text, '/tmp/p.txt');
      const stated = Number(/\[\.\.\. (\d+) characters not shown/.exec(shown)![1]);
      const head = shown.indexOf('\n\n[... ');
      const tail = shown.length - (shown.lastIndexOf(' ...]\n\n') + ' ...]\n\n'.length);
      expect([head + tail + stated, shown.length <= MAX_OUTPUT_CHARS]).toEqual([len, true]);
    }
  });

  test('a spill directory someone else planted is not used', () => {
    const root = mkdtempSync(join(tmpdir(), 'cedia-spill-root-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'cedia-spill-elsewhere-'));
    symlinkSync(elsewhere, join(root, 's1'));
    expect(spillOutput('s1', 'c1', 'secret output', root)).toBeUndefined();
    chmodSync(root, 0o777);
    expect(spillOutput('s2', 'c1', 'x', root)).toBeUndefined();
  });

  test('output under the limit stays in the result and writes no file', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'bash', { command: 'cat a.txt' })] }, { blocks: [text('ok')] }]);
    await runPrompt(opts, 'show a.txt');
    expect(of(log.events, 'tool_result')[0]!.output).toEqual({ text: 'alpha\n\n[exit 0]', isError: false, exitCode: 0 });
  });
});

describe('loop', () => {
  test('each reply logs its own cost, and they add up to the run\'s', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'read', { path: 'a.txt' })] }, { blocks: [text('it says alpha')] }]);
    const res = await runPrompt(opts, 'what is in a.txt');
    const costs = of(log.events, 'assistant').map((e) => e.costUsd);
    expect(costs).toHaveLength(2);
    for (const c of costs) expect(c).toBeGreaterThan(0);
    expect(costs.reduce((a, c) => a! + c!, 0)).toBeCloseTo(res.costUsd, 12);
  });

  test('runs a tool and answers; log order is request, attempt, assistant, permission, intent, result', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'read', { path: 'a.txt' })] }, { blocks: [text('it says alpha')] }]);
    const res = await runPrompt(opts, 'what is in a.txt');
    expect(res).toMatchObject({ subtype: 'success', numTurns: 2, result: 'it says alpha' });
    expect(kinds(log.events)).toEqual(['session', 'user', 'request', 'attempt', 'assistant', 'permission', 'tool_intent', 'tool_result', 'request', 'attempt', 'assistant', 'turn_end']);
    expect(of(log.events, 'tool_result')[0]!.output.text).toContain('alpha');
    expectPaired(log.events);
  });

  const slow = (ms: number) => ({ ...readTool, name: 'slow', pathOf: undefined, run: async () => (await Bun.sleep(ms), { text: 'done waiting', isError: false }) });

  test('while a tool runs long, the request is sent again with no output to keep its cache, and the spend counts', async () => {
    const { log, provider, opts } = setup([{ blocks: [toolUse('c1', 'slow', {})] }, { blocks: [text('done')] }], { keepAliveMs: 100, tools: [slow(350)] });
    const warmed: string[] = [];
    const usage = { uncached: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 };
    provider.keepAlive = async (req) => (warmed.push(JSON.stringify(provider.body(req))), { ok: true, usage });
    const res = await runPrompt(opts, 'go');
    expect(res.subtype).toBe('success');
    const kept = of(log.events, 'keepalive');
    // Every 100 ms from the request's start while the 350 ms command runs: about three, all for the first request.
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.length).toBeLessThanOrEqual(4);
    const first = of(log.events, 'request')[0]!;
    for (const k of kept) expect(k).toMatchObject({ requestId: first.id, usage });
    // The body is the first request's own, so the refresh hits the prefix the next request reads.
    expect(new Set(warmed).size).toBe(1);
    expect(hash(JSON.parse(warmed[0]!))).toBe(first.bodyHash);
    // Each refresh comes before the tool's result, and none after it.
    expect(log.events.findLastIndex((e) => e.kind === 'keepalive')).toBeLessThan(log.events.findIndex((e) => e.kind === 'tool_result'));
    expect(res.usage.cacheRead).toBeGreaterThanOrEqual(kept.length * 1_000_000);
    expect(res.costUsd).toBeGreaterThan(0);
    expectPaired(log.events);
  });

  test('a short tool, a provider without keepAlive, or keepAliveMs 0 sends nothing', async () => {
    const short = setup([{ blocks: [toolUse('c1', 'read', { path: 'a.txt' })] }, { blocks: [text('ok')] }], { keepAliveMs: 60_000 });
    let calls = 0;
    short.provider.keepAlive = async () => (calls++, { ok: true, usage: { uncached: 0, cacheRead: 1, cacheWrite: 0, output: 0 } });
    await runPrompt(short.opts, 'go');
    const off = setup([{ blocks: [toolUse('c1', 'slow', {})] }, { blocks: [text('ok')] }], { keepAliveMs: 0, tools: [slow(200)] });
    off.provider.keepAlive = short.provider.keepAlive;
    await runPrompt(off.opts, 'go');
    const none = setup([{ blocks: [toolUse('c1', 'slow', {})] }, { blocks: [text('ok')] }], { keepAliveMs: 50, tools: [slow(200)] });
    await runPrompt(none.opts, 'go');
    expect(calls).toBe(0);
    for (const l of [short.log, off.log, none.log]) expect(of(l.events, 'keepalive')).toEqual([]);
  });

  test('a failed refresh is logged and the session goes on', async () => {
    const { log, provider, opts } = setup([{ blocks: [toolUse('c1', 'slow', {})] }, { blocks: [text('ok')] }], { keepAliveMs: 100, tools: [slow(250)] });
    provider.keepAlive = async () => ({ ok: false, error: { code: 'server', message: 'overloaded' } });
    const res = await runPrompt(opts, 'go');
    expect(res.subtype).toBe('success');
    expect(of(log.events, 'keepalive')[0]).toMatchObject({ error: { code: 'server' } });
    expectPaired(log.events);
  });

  test('every result says where its time went, and attempts carry their timing', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'read', { path: 'a.txt' })] }, { blocks: [text('ok')] }]);
    const res = await runPrompt(opts, 'go');
    const t = res.timing!;
    for (const k of ['wallMs', 'modelMs', 'ttftMs', 'toolMs', 'retryMs', 'harnessMs', 'outputTokPerSec'] as const) expect(typeof t[k]).toBe('number');
    expect(t.wallMs).toBeGreaterThanOrEqual(t.modelMs);
    for (const a of of(log.events, 'attempt')) expect(a).toMatchObject({ ttftMs: expect.any(Number), ms: expect.any(Number) });
  });

  test('the default turn limit lets a session run past 50 turns', async () => {
    // Each call new, so the stuck guard has nothing to see.
    let n = 0;
    const loop: FauxStep = () => ({ blocks: [toolUse(`c${Math.random()}`, 'bash', { command: `echo ${n++}` })] });
    const { opts } = setup([...Array.from({ length: 80 }, () => loop), { blocks: [text('done')] }]);
    const res = await runPrompt(opts, 'loop');
    expect(res.subtype).toBe('success');
    expect(res.numTurns).toBe(81);
  });

  test('maxTurns stops with error_max_turns', async () => {
    const loop: FauxStep = () => ({ blocks: [toolUse(`c${Math.random()}`, 'read', { path: 'a.txt' })] });
    const { log, opts } = setup([loop, loop, loop, loop], { maxTurns: 3 });
    const res = await runPrompt(opts, 'loop');
    expect(res.subtype).toBe('error_max_turns');
    expect(res.numTurns).toBe(3);
    expect(of(log.events, 'turn_end')[0]!.reason).toBe('max_turns');
    expectPaired(log.events);
  });

  test('maxBudgetUsd stops with error_max_budget_usd and closes pending calls', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'read', { path: 'a.txt' })] }], { maxBudgetUsd: 1e-9 });
    const res = await runPrompt(opts, 'spend');
    expect(res.subtype).toBe('error_max_budget_usd');
    expect(of(log.events, 'tool_result')[0]!.status).toBe('not_started');
    expect(of(log.events, 'tool_intent')).toHaveLength(0);
    expectPaired(log.events);
  });

  test('retries rate limits with retry-after and logs each attempt', async () => {
    const { log, opts, sleeps } = setup([
      { error: { code: 'rate_limit', status: 429, retryAfterMs: 1234, message: 'slow down' } },
      { error: { code: 'overloaded', status: 529, message: 'busy' } },
      { blocks: [text('ok')] },
    ]);
    const res = await runPrompt(opts, 'hi');
    expect(res.subtype).toBe('success');
    expect(res.failure).toBeUndefined();
    // One session on one model: its usage by model is the whole of it.
    expect(res.modelUsage).toEqual({ [FAUX_MODEL.ref]: { ...res.usage, costUsd: res.costUsd, requests: 1 } });
    expect(sleeps).toEqual([1234, 2000]);
    expect(of(log.events, 'attempt').map((a) => [a.n, a.error?.code])).toEqual([[1, 'rate_limit'], [2, 'overloaded'], [3, undefined]]);
    expect(of(log.events, 'request')).toHaveLength(1);
    // Each wait is logged after the attempt it follows, so a client can say why the run is quiet.
    expect(of(log.events, 'retry')).toEqual([
      { kind: 'retry', requestId: of(log.events, 'request')[0]!.id, n: 1, waitMs: 1234, code: 'rate_limit', status: 429, of: 5 },
      { kind: 'retry', requestId: of(log.events, 'request')[0]!.id, n: 2, waitMs: 2000, code: 'overloaded', status: 529, of: 5 },
    ].map((r) => expect.objectContaining(r)));
    expect(kinds(log.events).slice(2, 8)).toEqual(['request', 'attempt', 'retry', 'attempt', 'retry', 'attempt']);
    expect(lintSession(log.events)).toEqual([]);
  });

  // Claude Code's retry watchdog waits for a usage limit to reset, up to a ceiling (2.1.295, 2.1.301, 2.1.305).
  test('a spent quota is waited out only when asked, only when it says when, and only up to the ceiling', async () => {
    const MIN = 60_000;
    const spent = (retryAfterMs?: number): FauxStep => ({ error: { code: 'quota', status: 429, message: 'usage limit reached', ...(retryAfterMs ? { retryAfterMs } : {}) } });
    const waits: number[] = [];
    const waited = setup([spent(20 * MIN), spent(20 * MIN), spent(20 * MIN), spent(20 * MIN), { blocks: [text('ok')] }], { quotaWaitMs: 30 * MIN, onQuotaWait: (ms) => void waits.push(ms) });
    expect(await runPrompt(waited.opts, 'hi')).toMatchObject({ subtype: 'success', timing: { retryMs: 20 * MIN } });
    // Sliced into 5-minute rechecks (quotaRecheckMs): each slice ends in a fresh request, same total, heard per slice.
    expect(waited.sleeps).toEqual([5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN]);
    expect(waits).toEqual([5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN]);
    expect(of(waited.log.events, 'attempt').map((a) => a.error?.code)).toEqual(['quota', 'quota', 'quota', 'quota', undefined]);
    // A quota wait counts against no attempt limit, so its retry event names none.
    expect(of(waited.log.events, 'retry').map((r) => [r.waitMs, r.code, r.of])).toEqual(Array(4).fill([5 * MIN, 'quota', undefined]));
    // A limit lifted before its reset ends the wait at the next slice, not at the reset.
    const early = setup([spent(20 * MIN), { blocks: [text('ok')] }], { quotaWaitMs: 30 * MIN });
    expect(await runPrompt(early.opts, 'hi')).toMatchObject({ subtype: 'success', timing: { retryMs: 5 * MIN } });
    expect(early.sleeps).toEqual([5 * MIN]);
    // Without the option a spent quota ends the session, so the client can fall back.
    const plain = setup([spent(20 * MIN), { blocks: [text('ok')] }]);
    expect((await runPrompt(plain.opts, 'hi')).subtype).toBe('error_during_execution');
    expect(plain.sleeps).toEqual([]);
    // The ceiling is for the whole run: a second 20-minute wait would pass 30 minutes.
    const twice = setup([spent(20 * MIN), spent(20 * MIN), spent(20 * MIN), spent(20 * MIN), spent(20 * MIN), spent(20 * MIN), spent(20 * MIN), { blocks: [text('ok')] }], { quotaWaitMs: 30 * MIN });
    expect((await runPrompt(twice.opts, 'hi')).subtype).toBe('error_during_execution');
    expect(twice.sleeps).toEqual([5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN]);
    // A spent balance says no time: waiting will not bring it back.
    const balance = setup([{ error: { code: 'quota', status: 402, message: 'Insufficient Balance' } }, { blocks: [text('ok')] }], { quotaWaitMs: 30 * MIN });
    expect(await runPrompt(balance.opts, 'hi')).toMatchObject({ subtype: 'error_during_execution', failure: { cause: 'api_error', code: 'quota', status: 402 } });
    expect(balance.sleeps).toEqual([]);
  });

  test('gives up after 5 attempts', async () => {
    const err: FauxStep = { error: { code: 'server', status: 500, message: 'boom' } };
    const { log, opts } = setup([err, err, err, err, err, err]);
    const res = await runPrompt(opts, 'hi');
    expect(res.subtype).toBe('error_during_execution');
    expect(res.failure).toEqual({ cause: 'api_error', code: 'server', status: 500 });
    expect(of(log.events, 'attempt')).toHaveLength(5);
  });

  test('never retries auth, bad_request or context_length', async () => {
    for (const code of ['auth', 'bad_request', 'context_length'] as const) {
      const { log, opts } = setup([{ error: { code, message: code } }, { blocks: [text('unreachable')] }]);
      const res = await runPrompt(opts, 'hi');
      expect(res.subtype).toBe('error_during_execution');
      expect(res.failure).toEqual({ cause: 'api_error', code });
      expect(of(log.events, 'attempt')).toHaveLength(1);
    }
  });

  test('abort during a retry wait ends at once with interrupted', async () => {
    const ac = new AbortController();
    const { opts } = setup([{ error: { code: 'rate_limit', status: 429, retryAfterMs: 600_000, message: 'later' } }, { blocks: [text('unreachable')] }], { signal: ac.signal, retry: {} });
    const p = runPrompt(opts, 'wait');
    setTimeout(() => ac.abort(), 10);
    const start = Date.now();
    const res = await p;
    expect(res.subtype).toBe('interrupted');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('abort mid-stream ends with interrupted and turn_end aborted', async () => {
    const ac = new AbortController();
    const { log, opts } = setup([{ hang: true }], { signal: ac.signal });
    const p = runPrompt(opts, 'wait');
    setTimeout(() => ac.abort(), 10);
    const res = await p;
    expect(res.subtype).toBe('interrupted');
    expect(of(log.events, 'turn_end')[0]).toMatchObject({ reason: 'aborted', cause: 'user' });
    expect(of(log.events, 'assistant')[0]!.stop).toBe('aborted');
  });

  test('abort while tools run still gives every call of the reply a result', async () => {
    const ac = new AbortController();
    const calls = [toolUse('c1', 'bash', { command: 'sleep 30' }), toolUse('c2', 'read', { path: 'a.txt' }), toolUse('c3', 'bash', { command: 'sleep 30' })];
    const { log, opts } = setup([{ blocks: calls }, { blocks: [text('never')] }], { signal: ac.signal, permission: { mode: 'workspace', allow: [], deny: [] } });
    const p = runPrompt(opts, 'wait');
    setTimeout(() => ac.abort(), 300);
    const t = performance.now();
    const res = await p;
    expect(performance.now() - t).toBeLessThan(5000);
    expect(res.subtype).toBe('interrupted');
    expectPaired(log.events);
  });

  test('bad tool input, unknown tools and denied commands still get results', async () => {
    const { log, opts } = setup([
      {
        blocks: [
          { type: 'tool_use', id: 'c1', name: 'read', input: {}, inputError: 'invalid JSON in tool input' },
          toolUse('c2', 'write', { path: 'x' }),
          toolUse('c3', 'bash', { command: 'rm -rf /' }),
        ],
      },
      { blocks: [text('sorry')] },
    ]);
    await runPrompt(opts, 'go');
    const results = of(log.events, 'tool_result');
    expect(results.map((r) => r.status)).toEqual(['not_started', 'not_started', 'denied']);
    expect(results[2]!.output.text).toContain('deny-list:rm-outside');
    expect(of(log.events, 'permission').map((p) => [p.callId, p.decision])).toEqual([['c3', 'deny']]);
    expect(of(log.events, 'tool_intent')).toEqual([]);
    expectPaired(log.events);
  });

  test('a reply cut off by max_tokens continues', async () => {
    const { log, opts } = setup([{ blocks: [text('part one')], stop: 'max_tokens' }, { blocks: [text(' part two')] }]);
    const res = await runPrompt(opts, 'write a lot');
    expect(res.subtype).toBe('success');
    expect(of(log.events, 'reminder')[0]!.text).toBe(CONTINUE_AFTER_LIMIT);
  });

  test('a tool call cut off by max_tokens gets an error result and the loop goes on', async () => {
    const { log, opts } = setup([
      { blocks: [{ type: 'tool_use', id: 'c1', name: 'read', input: {}, inputError: 'tool call was cut off by the output limit' }], stop: 'max_tokens' },
      { blocks: [text('retrying differently')] },
    ]);
    const res = await runPrompt(opts, 'go');
    expect(res.subtype).toBe('success');
    expect(of(log.events, 'tool_result')[0]!.output.text).toContain('cut off');
    expectPaired(log.events);
  });

  test('models that train on prompts only run in repos marked public', async () => {
    const muse = { ...resolveModel('muse'), wire: 'faux' as const };
    const { opts } = setup([{ blocks: [text('hi')] }], { model: muse });
    expect((await runPrompt(opts, 'hi')).subtype).toBe('error_during_execution');

    const pub = mkdtempSync(join(tmpdir(), 'cedia-public-'));
    mkdirSync(join(pub, '.cedia'));
    writeFileSync(join(pub, '.cedia', 'public'), '');
    const second = setup([{ blocks: [text('hi')] }], { model: muse, cwd: pub });
    expect((await runPrompt(second.opts, 'hi')).subtype).toBe('success');
  });

  test('privacy zdr refuses models that keep prompts', async () => {
    const haiku = { ...resolveModel('anthropic/claude-haiku-5-5'), wire: 'faux' as const };
    const kept = await runPrompt(setup([{ blocks: [text('hi')] }], { model: haiku, privacy: 'zdr' }).opts, 'hi');
    expect(kept).toMatchObject({ subtype: 'error_during_execution', result: expect.stringContaining('zero-data-retention') });
    expect((await runPrompt(setup([{ blocks: [text('hi')] }], { model: haiku }).opts, 'hi')).subtype).toBe('success');
    const zdr = { ...resolveModel('deepseek'), wire: 'faux' as const };
    expect((await runPrompt(setup([{ blocks: [text('hi')] }], { model: zdr, privacy: 'zdr' }).opts, 'hi')).subtype).toBe('success');
  });

  test('secrets in tool output are redacted before they are logged or sent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-secret-'));
    const key = 'sk-proj-' + 'Ab3'.repeat(10);
    writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${key}\nDEBUG=1\n`);
    const path = join(dir, 's.jsonl');
    const log = SessionLog.create({ path });
    const steps: FauxStep[] = [{ blocks: [toolUse('c1', 'read', { path: '.env' })] }, { blocks: [text('done')] }];
    const provider = fauxProvider(steps);
    await runPrompt({ log, provider, model: FAUX_MODEL, tools: [readTool], system: 'sys', cwd: dir }, 'show env');
    const result = of(log.events, 'tool_result')[0]!;
    expect(result.output.text).toContain('OPENAI_API_KEY=[cedia:redacted]');
    expect(result.output.text).toContain('DEBUG=1');
    expect(result.output.redacted).toBe(1);
    // The model is told a value was hidden, and that the file still holds it.
    expect(result.output.text).toContain('[cedia: a value in this result looked like a secret');
    expect(readFileSync(path, 'utf8')).not.toContain(key);
    expect(provider.state.bodies.length).toBe(2);
    expect(JSON.stringify(provider.state.bodies)).not.toContain(key);

    const open = SessionLog.create();
    await runPrompt({ log: open, provider: fauxProvider(steps), model: FAUX_MODEL, tools: [readTool], system: 'sys', cwd: dir, permission: { mode: 'read-only', allow: [], deny: [], unlock: ['secret-redaction'] } }, 'show env');
    expect(of(open.events, 'tool_result')[0]!.output.text).toContain(key);
  });

  test('header values never reach the log file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-log-'));
    const path = join(dir, 's.jsonl');
    const log = SessionLog.create({ path });
    const provider = fauxProvider([{ blocks: [text('ok')] }]);
    provider.headers = () => ({ Authorization: 'Bearer sk-secret-value', 'x-opencode-session': 'abc' });
    await runPrompt({ log, provider, model: FAUX_MODEL, tools: [], system: 's', cwd }, 'hi');
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('sk-secret-value');
    const req = of(SessionLog.load(path).events, 'request')[0]!;
    expect(Object.keys(req.headers).sort()).toEqual(['authorization', 'x-opencode-session']);
  });

  test('read-only sessions deny writes; workspace sessions apply them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-perm-'));
    writeFileSync(join(dir, 'f.ts'), 'const a = 1;\n');
    const steps = (): FauxStep[] => [
      { blocks: [toolUse('e1', 'edit', { path: 'f.ts', edits: [{ old_text: 'a = 1', new_text: 'a = 2' }] }), toolUse('b1', 'bash', { command: 'touch made.txt' })] },
      { blocks: [text('done')] },
    ];
    const ro = setup(steps(), { cwd: dir, tools: CORE_TOOLS });
    await runPrompt(ro.opts, 'go');
    expect(of(ro.log.events, 'tool_result').map((r) => r.status)).toEqual(['denied', 'denied']);
    expect(readFileSync(join(dir, 'f.ts'), 'utf8')).toBe('const a = 1;\n');

    const ws = setup(steps(), { cwd: dir, tools: CORE_TOOLS, permission: { mode: 'workspace', allow: [], deny: [] } });
    await runPrompt(ws.opts, 'go');
    expect(of(ws.log.events, 'tool_result').map((r) => r.status)).toEqual(['completed', 'completed']);
    expect(readFileSync(join(dir, 'f.ts'), 'utf8')).toBe('const a = 2;\n');
    expect(kinds(ws.log.events).slice(5, 11)).toEqual(['permission', 'tool_intent', 'permission', 'tool_intent', 'tool_result', 'tool_result']);
    expectPaired(ws.log.events);
  });

  test('an allow rule lets one command through a read-only session, but not what it is chained with', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-allow-'));
    const { log, opts } = setup(
      [
        { blocks: [toolUse('b1', 'bash', { command: 'touch ok.txt && ls' }), toolUse('b2', 'bash', { command: 'touch ok.txt && touch bad.txt' })] },
        { blocks: [text('done')] },
      ],
      { cwd: dir, permission: { mode: 'read-only', allow: ['bash(touch ok.txt)'], deny: [] } },
    );
    await runPrompt(opts, 'go');
    expect(of(log.events, 'permission').map((p) => p.rule)).toEqual(['allow:bash(touch ok.txt)', 'mode:read-only']);
    expect(of(log.events, 'tool_result').map((r) => r.status)).toEqual(['completed', 'denied']);
  });

  test('read-only bash calls run together; a writing call is a barrier', async () => {
    const order: string[] = [];
    const slow = (name: string, effect: 'read' | 'exec', ms: number) => ({
      ...readTool,
      name,
      effect,
      async run() {
        order.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end ${name}`);
        return { text: name, isError: false };
      },
    });
    const { opts } = setup(
      [{ blocks: [toolUse('1', 'r1', {}), toolUse('2', 'r2', {}), toolUse('3', 'w', {}), toolUse('4', 'r3', {})] }, { blocks: [text('ok')] }],
      { tools: [slow('r1', 'read', 20), slow('r2', 'read', 5), slow('w', 'exec', 1), slow('r3', 'read', 1)], permission: { mode: 'workspace', allow: [], deny: [] } },
    );
    await runPrompt(opts, 'go');
    expect(order).toEqual(['start r1', 'start r2', 'end r2', 'end r1', 'start w', 'end w', 'start r3', 'end r3']);
  });

  describe('done gate', () => {
    const fixA = () => toolUse(`e${Math.random()}`, 'edit', { path: 'g.ts', edits: [{ old_text: 'x = 1', new_text: 'x = 2' }] });
    const run = (cmd: string) => toolUse(`b${Math.random()}`, 'bash', { command: cmd });
    const gate = (steps: FauxStep[], checks?: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'cedia-gate-'));
      writeFileSync(join(dir, 'g.ts'), 'const x = 1;\n');
      return setup(steps, { cwd: dir, tools: CORE_TOOLS, permission: { mode: 'workspace', allow: [], deny: [] }, ...(checks ? { checks } : {}) });
    };

    test('a passing declared check after the last write: success with evidence', async () => {
      const { log, opts } = gate([{ blocks: [fixA()] }, { blocks: [run('true 2>&1')] }, { blocks: [text('fixed')] }], ['true']);
      const res = await runPrompt(opts, 'fix');
      expect(res.subtype).toBe('success');
      expect(res.evidence).toEqual({ changed: ['g.ts'], checks: [{ command: 'true', exitCode: 0 }], unverified: [] });
      expectPaired(log.events);
    });

    test('a claim without a check gets one reminder, then error_unverified_claim', async () => {
      const { log, opts } = gate([{ blocks: [fixA()] }, { blocks: [text('done')] }, { blocks: [text('really done')] }], ['true']);
      const res = await runPrompt(opts, 'fix');
      expect(res.subtype).toBe('error_unverified_claim');
      expect(res.evidence?.unverified).toEqual(['g.ts']);
      expect(of(log.events, 'reminder').map((r) => r.text)).toEqual([expect.stringContaining('`true`')]);
      expectPaired(log.events);
    });

    test('the reminder works when the model then runs the check', async () => {
      const { opts } = gate([{ blocks: [fixA()] }, { blocks: [text('done')] }, { blocks: [run('true')] }, { blocks: [text('checked')] }], ['true']);
      expect((await runPrompt(opts, 'fix')).subtype).toBe('success');
    });

    test('a failing check, a check before the write, or a piped check does not count', async () => {
      for (const steps of [
        [{ blocks: [fixA()] }, { blocks: [run('false')] }, { blocks: [text('done')] }, { blocks: [text('done')] }],
        [{ blocks: [run('true')] }, { blocks: [fixA()] }, { blocks: [text('done')] }, { blocks: [text('done')] }],
        [{ blocks: [fixA()] }, { blocks: [run('true | cat')] }, { blocks: [text('done')] }, { blocks: [text('done')] }],
      ] as FauxStep[][]) {
        const { opts } = gate(steps, ['true', 'false']);
        expect((await runPrompt(opts, 'fix')).subtype).toBe('error_unverified_claim');
      }
    });

    test('a piped declared check is named in its own result, the exact check is not', async () => {
      const { log, opts } = gate([{ blocks: [fixA()] }, { blocks: [run('echo hi && true | cat')] }, { blocks: [run('true | cat')] }, { blocks: [text('fixed')] }], ['true | cat']);
      // 'true | cat' is the declared check here; running it after `echo hi &&` is a longer command.
      expect((await runPrompt(opts, 'fix')).subtype).toBe('success');
      const results = of(log.events, 'tool_result').map((r) => r.output.text);
      expect(results[1]).toContain('[cedia: this command holds the declared check `true | cat` but is not just it');
      expect(results.filter((t) => t.includes('[cedia: this command holds'))).toHaveLength(1);
      expect(nearCheck('true | cat', ['true | cat'])).toBeUndefined();
      expect(nearCheck('bun test 2>&1 | tail -20', ['bun test'])).toBe('bun test');
      expect(nearCheck('ls', ['bun test'])).toBeUndefined();
      expect(nearCheck('bun test', [])).toBeUndefined();
    });

    test('without declared checks the gate is off but the receipt still lists what is unverified', async () => {
      const { opts } = gate([{ blocks: [fixA(), run('touch made.txt')] }, { blocks: [text('done')] }]);
      const res = await runPrompt(opts, 'fix');
      expect(res.subtype).toBe('success');
      expect(res.evidence).toEqual({ changed: ['g.ts', 'bash: touch made.txt'], checks: [], unverified: ['g.ts', 'bash: touch made.txt'] });
    });

    describe('escalation', () => {
      // FAUX_MODEL as a model with per-message effort, started cheap.
      const claudeLike = { ...FAUX_MODEL, caps: { ...FAUX_MODEL.caps, midConversationEffort: true, effortLevels: EFFORTS } };
      const esc = (steps: FauxStep[], extra: Partial<RunOptions> = {}) => {
        const g = gate(steps, ['true', 'false']);
        Object.assign(g.opts, { model: claudeLike, effort: 'low', escalate: 'high' }, extra);
        return g;
      };

      test('a refused claim raises effort once, right after the reminder, and every earlier message stays as sent', async () => {
        const { log, opts, provider } = esc([{ blocks: [fixA()] }, { blocks: [text('done')] }, { blocks: [run('true')] }, { blocks: [text('checked')] }]);
        expect((await runPrompt(opts, 'fix')).subtype).toBe('success');
        const at = kinds(log.events).indexOf('effort');
        expect(kinds(log.events).slice(at - 2, at + 2)).toEqual(['assistant', 'reminder', 'effort', 'request']);
        expect(of(log.events, 'effort')).toEqual([expect.objectContaining({ effort: 'high' })]);
        const bodies = provider.state.bodies as any[];
        expect(bodies[2].messages.slice(-2)).toEqual([{ role: 'user', parts: [{ type: 'text', text: expect.stringContaining('`true`') }] }, { role: 'effort', effort: 'high' }]);
        // Cache: each request's messages start with the previous request's, byte for byte.
        for (let i = 1; i < bodies.length; i++) expect(JSON.stringify(bodies[i].messages)).toStartWith(JSON.stringify(bodies[i - 1].messages).slice(0, -1));
        // The top-level effort never changes.
        expect(new Set(of(log.events, 'request').map((r) => r.effort))).toEqual(new Set(['low']));
        expectPaired(log.events);
      });

      test('a failed check alone does not escalate: only the refused claim does', async () => {
        const { log, opts } = esc([{ blocks: [fixA()] }, { blocks: [run('false')] }, { blocks: [run('true')] }, { blocks: [text('fixed')] }]);
        expect((await runPrompt(opts, 'fix')).subtype).toBe('success');
        expect(of(log.events, 'effort')).toEqual([]);
        expect(of(log.events, 'reminder')).toEqual([]);
      });

      test('no escalation without per-message effort, without a step up, with escalate off, or on soft checks', async () => {
        const steps = (): FauxStep[] => [{ blocks: [fixA()] }, { blocks: [run('false')] }, { blocks: [text('done')] }, { blocks: [text('done')] }];
        for (const extra of [{ model: FAUX_MODEL }, { effort: 'high' as const }, { escalate: undefined }, { softChecks: true }] as Partial<RunOptions>[]) {
          const { log, opts } = esc(steps(), extra);
          await runPrompt(opts, 'fix');
          expect(of(log.events, 'effort')).toEqual([]);
        }
      });

      test('the target follows the model: its levels, its start, its capability', () => {
        const opus = resolveModel('opus');
        expect(escalationTarget(opus, 'low', 'high')).toBe('high');
        expect(escalationTarget(opus, 'medium', 'medium')).toBeUndefined();
        expect(escalationTarget(opus, 'xhigh', 'high')).toBeUndefined();
        expect(escalationTarget(opus, undefined, 'high')).toBeUndefined();
        expect(escalationTarget(resolveModel('deepseek'), 'low', 'high')).toBeUndefined();
        expect(escalationTarget(resolveModel('grok'), 'low', 'high')).toBeUndefined();
        expect(escalationTarget(resolveModel('haiku'), 'medium', 'high')).toBe('high');
      });
    });

    test('a run that only reads needs no check and has no evidence', async () => {
      const { opts } = gate([{ blocks: [run('cat g.ts')] }, { blocks: [text('x is 1')] }], ['true']);
      const res = await runPrompt(opts, 'read');
      expect(res.subtype).toBe('success');
      expect(res.evidence).toBeUndefined();
    });
  });
});

// Malformed turns Claude Code's changelog records hanging or misreporting (2.1.183, 2.1.251, 2.1.274, 2.1.281,
// 2.1.286). Each one ends inside the turn limit, keeps every tool_use paired, and says what happened.
describe('malformed turns', () => {
  const thinking = (t: string) => ({ type: 'thinking' as const, text: t, opaque: 'sig' });

  test('a reply with only thinking is not an answer: one reminder, then the run fails', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'read', { path: 'a.txt' })] }, { blocks: [thinking('hmm')] }, { blocks: [text('it says alpha')] }]);
    const res = await runPrompt(opts, 'what is in a.txt');
    expect(res).toMatchObject({ subtype: 'success', result: 'it says alpha' });
    expect(of(log.events, 'reminder').map((r) => r.text)).toEqual([EMPTY_REPLY]);
    expectPaired(log.events);

    const empty = setup([{ blocks: [text('looking')], stop: 'max_tokens' }, { blocks: [thinking('hmm')] }, { blocks: [] }]);
    const failed = await runPrompt(empty.opts, 'go');
    expect(failed.subtype).toBe('error_during_execution');
    expect(failed.result).toContain('without a reply');
    expect(failed.failure).toEqual({ cause: 'empty_reply' });
    expect(of(empty.log.events, 'turn_end')[0]!.reason).toBe('error');
    expectPaired(empty.log.events);
  });

  test('a refusal is not a success', async () => {
    const { opts } = setup([{ blocks: [text('I will not do that.')], stop: 'refusal' }]);
    expect(await runPrompt(opts, 'go')).toMatchObject({ subtype: 'error_during_execution', result: 'I will not do that.', failure: { cause: 'refusal' } });
    const silent = setup([{ blocks: [], stop: 'refusal' }]);
    expect((await runPrompt(silent.opts, 'go')).result).toContain('declined');
    // The provider's category and explanation reach the result and the log, so a refusal says which classifier fired.
    const flagged = setup([{ blocks: [], stop: 'refusal', refusal: { category: 'cyber', explanation: 'flagged as offensive security' } }]);
    const res = await runPrompt(flagged.opts, 'go');
    expect(res.failure).toEqual({ cause: 'refusal', category: 'cyber' });
    expect(res.result).toContain('declined (cyber): flagged as offensive security');
    expect(of(flagged.log.events, 'assistant')[0]!.refusal).toEqual({ category: 'cyber', explanation: 'flagged as offensive security' });
  });

  test('a turn another model served is logged with that model', async () => {
    const { opts, log } = setup([{ blocks: [text('done')], served: 'claude-opus-4-8' }]);
    expect((await runPrompt(opts, 'go')).subtype).toBe('success');
    expect(of(log.events, 'assistant')[0]!.servedBy).toBe('claude-opus-4-8');
    const same = setup([{ blocks: [text('done')] }]);
    await runPrompt(same.opts, 'go');
    expect(of(same.log.events, 'assistant')[0]!.servedBy).toBeUndefined();
  });

  test('a tool that returns something other than text, or throws a non-Error, still gets a string result', async () => {
    const odd = (name: string, run: () => Promise<unknown>) => ({ name, description: name, schema: { type: 'object' }, effect: 'read' as const, replay: 'safe' as const, run: run as never });
    const tools = [
      odd('object', async () => ({ text: { rows: [1, 2] }, isError: false })),
      odd('nothing', async () => undefined),
      odd('throws', async () => {
        throw 'plain string';
      }),
    ];
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'object', {}), toolUse('c2', 'nothing', {}), toolUse('c3', 'throws', {})] }, { blocks: [text('ok')] }], { tools });
    expect((await runPrompt(opts, 'go')).subtype).toBe('success');
    const results = of(log.events, 'tool_result');
    for (const r of results) expect(typeof r.output.text).toBe('string');
    expect(results.map((r) => [r.status, r.output.text])).toEqual([
      ['completed', '{"rows":[1,2]}'],
      ['failed', 'tool returned no output'],
      ['failed', 'tool crashed: plain string'],
    ]);
    expectPaired(log.events);
  });

  test('two calls that share an id run once and get one result', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('dup', 'bash', { command: 'echo one' }), toolUse('dup', 'bash', { command: 'echo two' })] }, { blocks: [text('ok')] }]);
    await runPrompt(opts, 'go');
    const results = of(log.events, 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.output.text).toContain('one');
    expect(results[0]!.output.text).toContain('shared this id');
    expect(of(log.events, 'tool_intent')).toHaveLength(1);
    expect(lintSession(log.events)).toEqual([]);
  });

  test('a tool name longer than any tool gets a short not-run result and the run goes on', async () => {
    const long = 'x'.repeat(300);
    const { log, opts } = setup([{ blocks: [toolUse('c1', long, {})] }, { blocks: [text('ok')] }]);
    expect((await runPrompt(opts, 'go')).subtype).toBe('success');
    const r = of(log.events, 'tool_result')[0]!;
    expect(r.status).toBe('not_started');
    expect(r.output.text.length).toBeLessThan(200);
    expectPaired(log.events);
  });

  test('unparseable calls alternating with cut-off replies stop at the turn limit', async () => {
    const cut: FauxStep = () => ({ blocks: [{ type: 'tool_use', id: `c${Math.random()}`, name: 'read', input: {}, inputError: 'tool call was cut off by the output limit' }], stop: 'max_tokens' });
    const long: FauxStep = { blocks: [text('...')], stop: 'max_tokens' };
    const { log, opts } = setup([cut, long, cut, long, cut, long, cut, long], { maxTurns: 5 });
    expect(await runPrompt(opts, 'go')).toMatchObject({ subtype: 'error_max_turns', numTurns: 5 });
    expectPaired(log.events);
  });
});

describe('beta-gated gateway fallback', () => {
  const betaError = { error: { code: 'bad_request', status: 400, message: 'invalid_request_error: the anthropic-beta header value is not supported by this gateway' } } as const;
  test('one stripped resend on a beta rejection, then success; attempts show the rejection', async () => {
    const base = fauxProvider((req, state) => (state.callCount > 1 ? { blocks: [text('done')] } : betaError));
    let strips = 0;
    const provider = { ...base, stripForGateway: (req: WireRequest) => { strips++; return { ...req }; } };
    const { log, opts } = setup([], { provider });
    const r = await runPrompt(opts, 'hi');
    expect(r.subtype).toBe('success');
    expect(r.result).toBe('done');
    expect(strips).toBe(1);
    expect(base.state.callCount).toBe(2);
    expect(of(log.events, 'attempt')).toHaveLength(2);
    expect(of(log.events, 'attempt')[0]).toMatchObject({ n: 1, error: { code: 'bad_request' } });
    expectPaired(log.events);
  });
  test('a bad request that names no beta, or a strip that changes nothing, ends the run', async () => {
    const plain = fauxProvider([{ error: { code: 'bad_request', status: 400, message: 'invalid_request_error: prompt is empty' } }]);
    const s1 = setup([], { provider: { ...plain, stripForGateway: () => undefined } });
    expect((await runPrompt(s1.opts, 'hi')).subtype).toBe('error_during_execution');
    expect(plain.state.callCount).toBe(1);
  });
});

describe('repeat checks', () => {
  test('a declared check that passed does not run again until a write', async () => {
    const { log, opts } = setup(
      [{ blocks: [toolUse('c1', 'bash', { command: 'true' })] }, { blocks: [toolUse('c2', 'bash', { command: 'true' })] }, { blocks: [text('done')] }],
      { checks: ['true'], permission: { mode: 'workspace', allow: [], deny: [] } },
    );
    const r = await runPrompt(opts, 'check twice');
    expect(r.subtype).toBe('success');
    const results = of(log.events, 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ status: 'completed' });
    expect(results[1]).toMatchObject({ status: 'denied' });
    expect(results[1]!.output.text).toContain('already passed with nothing written since');
    // A skipped repeat is not a refusal the report should mention.
    expect(results[1]!.output.text).toStartWith('not run: ');
    expect(results[1]!.output.text).not.toContain('tell the user');
    expect(of(log.events, 'permission').filter((p) => p.decision === 'deny').map((p) => p.rule)).toEqual(['repeat-check']);
    expectPaired(log.events);
  });

  test('a failed check always reruns, and a write re-arms a passed one', async () => {
    const { log, opts } = setup(
      [{ blocks: [toolUse('c1', 'bash', { command: 'false' })] }, { blocks: [toolUse('c2', 'bash', { command: 'false' })] }, { blocks: [text('done')] }],
      { checks: ['false'], permission: { mode: 'workspace', allow: [], deny: [] } },
    );
    await runPrompt(opts, 'failing check twice');
    const results = of(log.events, 'tool_result');
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expectPaired(log.events);
  });
});

describe('plan overlap', () => {
  const ws = { mode: 'workspace' as const, allow: [], deny: [] };
  // A plan that arrives when the test says so.
  const later = () => {
    let settle!: (t: string | undefined) => void;
    const text = new Promise<string | undefined>((r) => (settle = r));
    return { text, settle };
  };
  const reminder = (t: string) => `<plan>${t}</plan>`;

  test('reads run before the plan; a write waits for it, comes back not started, and the plan goes first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-overlap-'));
    writeFileSync(join(dir, 'a.txt'), 'alpha\n');
    const p = later();
    const { log, opts } = setup(
      [
        { blocks: [toolUse('c1', 'read', { path: 'a.txt' }), toolUse('c2', 'bash', { command: 'cat a.txt' })] },
        { blocks: [toolUse('c3', 'bash', { command: 'echo x > b.txt' })] },
        { blocks: [toolUse('c4', 'bash', { command: 'echo y > b.txt' })] },
        { blocks: [text('done')] },
      ],
      { cwd: dir, permission: ws, plan: { text: p.text, reminder } },
    );
    const run = runPrompt(opts, 'task');
    // The reads ran with no plan yet; the write is held.
    await Bun.sleep(50);
    const early = of(log.events, 'tool_result');
    expect(early.map((r) => [r.callId, r.status])).toEqual([['c1', 'completed'], ['c2', 'completed']]);
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    p.settle('  write y to b.txt  ');
    const r = await run;
    expect(r.subtype).toBe('success');
    const c3 = of(log.events, 'tool_result').find((e) => e.callId === 'c3')!;
    expect(c3).toMatchObject({ status: 'not_started', output: { text: PLAN_FIRST, isError: true } });
    const at = log.events.findIndex((e) => e.kind === 'reminder' && e.text === '<plan>write y to b.txt</plan>');
    expect(at).toBeGreaterThan(log.events.indexOf(c3));
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('y\n');
    expectPaired(log.events);
  });

  test('a turn that reads and writes before the plan: the read runs, the write comes back not started, then the plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-overlap-'));
    writeFileSync(join(dir, 'a.txt'), 'alpha\n');
    const p = later();
    const { log, opts } = setup(
      [
        { blocks: [toolUse('c1', 'read', { path: 'a.txt' }), toolUse('c2', 'bash', { command: 'echo x > b.txt' })] },
        { blocks: [text('done')] },
      ],
      { cwd: dir, permission: ws, plan: { text: p.text, reminder } },
    );
    const run = runPrompt(opts, 'task');
    setTimeout(() => p.settle('read a.txt first'), 20);
    expect((await run).subtype).toBe('success');
    const results = of(log.events, 'tool_result');
    expect(results.find((e) => e.callId === 'c1')).toMatchObject({ status: 'completed' });
    expect(results.find((e) => e.callId === 'c1')!.output.text).toContain('alpha');
    expect(results.find((e) => e.callId === 'c2')).toMatchObject({ status: 'not_started', output: { text: PLAN_FIRST, isError: true } });
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    const at = log.events.findIndex((e) => e.kind === 'reminder' && e.text === '<plan>read a.txt first</plan>');
    expect(at).toBeGreaterThan(Math.max(...results.map((r) => log.events.indexOf(r))));
    expectPaired(log.events);
  });

  test('a turn that ends before the plan waits for it, and the session goes on with it', async () => {
    const p = later();
    let delivered = 0;
    const { log, opts } = setup([{ blocks: [text('read everything')] }, { blocks: [text('done with the plan')] }], { plan: { text: p.text, reminder, delivered: () => delivered++ } });
    const run = runPrompt(opts, 'task');
    setTimeout(() => p.settle('the plan'), 20);
    const r = await run;
    expect(r).toMatchObject({ subtype: 'success', result: 'done with the plan' });
    expect(of(log.events, 'reminder').map((e) => e.text)).toEqual(['<plan>the plan</plan>']);
    expect(delivered).toBe(1);
  });

  test('no plan: the held write runs and the session ends as it would have', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-overlap-'));
    const p = later();
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'bash', { command: 'echo x > b.txt' })] }, { blocks: [text('wrote it')] }], { cwd: dir, permission: ws, plan: { text: p.text, reminder } });
    const run = runPrompt(opts, 'task');
    setTimeout(() => p.settle(undefined), 20);
    expect(await run).toMatchObject({ subtype: 'success', result: 'wrote it' });
    expect(of(log.events, 'tool_result')[0]!.status).toBe('completed');
    expect(of(log.events, 'reminder')).toEqual([]);
    expectPaired(log.events);
  });

  test('a stop while a write waits for the plan answers the call and ends the run', async () => {
    const ac = new AbortController();
    const p = later();
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'bash', { command: 'echo x > b.txt' })] }], { signal: ac.signal, permission: ws, plan: { text: p.text, reminder } });
    const run = runPrompt(opts, 'task');
    setTimeout(() => ac.abort(), 20);
    expect((await run).subtype).toBe('interrupted');
    expect(of(log.events, 'tool_result')[0]).toMatchObject({ status: 'not_started' });
    expectPaired(log.events);
  });
});
