import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTINUE_AFTER_LIMIT, runPrompt, type RunOptions } from '../src/core/loop/run.ts';
import { FAUX_MODEL, resolveModel } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse, type FauxStep } from '../src/core/providers/faux.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { readTool } from '../src/core/tools/read.ts';
import type { EventOf, SessionEvent } from '../src/core/types.ts';

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
}

describe('loop', () => {
  test('runs a tool and answers; log order is request, attempt, assistant, intent, result', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'read', { path: 'a.txt' })] }, { blocks: [text('it says alpha')] }]);
    const res = await runPrompt(opts, 'what is in a.txt');
    expect(res).toMatchObject({ subtype: 'success', numTurns: 2, result: 'it says alpha' });
    expect(kinds(log.events)).toEqual(['session', 'user', 'request', 'attempt', 'assistant', 'tool_intent', 'tool_result', 'request', 'attempt', 'assistant', 'turn_end']);
    expect(of(log.events, 'tool_result')[0]!.output.text).toContain('alpha');
    expectPaired(log.events);
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
    expect(sleeps).toEqual([1234, 2000]);
    expect(of(log.events, 'attempt').map((a) => [a.n, a.error?.code])).toEqual([[1, 'rate_limit'], [2, 'overloaded'], [3, undefined]]);
    expect(of(log.events, 'request')).toHaveLength(1);
  });

  test('gives up after 5 attempts', async () => {
    const err: FauxStep = { error: { code: 'server', status: 500, message: 'boom' } };
    const { log, opts } = setup([err, err, err, err, err, err]);
    const res = await runPrompt(opts, 'hi');
    expect(res.subtype).toBe('error_during_execution');
    expect(of(log.events, 'attempt')).toHaveLength(5);
  });

  test('never retries auth, bad_request or context_length', async () => {
    for (const code of ['auth', 'bad_request', 'context_length'] as const) {
      const { log, opts } = setup([{ error: { code, message: code } }, { blocks: [text('unreachable')] }]);
      const res = await runPrompt(opts, 'hi');
      expect(res.subtype).toBe('error_during_execution');
      expect(of(log.events, 'attempt')).toHaveLength(1);
    }
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

  test('bad tool input, unknown tools and refused commands still get results', async () => {
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
    expect(results.map((r) => r.status)).toEqual(['not_started', 'not_started', 'failed']);
    expect(results[2]!.output.text).toContain('refused');
    expect(of(log.events, 'tool_intent').map((i) => i.callId)).toEqual(['c3']);
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
});
