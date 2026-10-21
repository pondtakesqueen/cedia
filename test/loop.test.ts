import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTINUE_AFTER_LIMIT, runPrompt, type RunOptions } from '../src/core/loop/run.ts';
import { FAUX_MODEL, resolveModel } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse, type FauxStep } from '../src/core/providers/faux.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { CORE_TOOLS } from '../src/core/tools/index.ts';
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
  expect(lintSession(events)).toEqual([]);
}

describe('loop', () => {
  test('runs a tool and answers; log order is request, attempt, assistant, permission, intent, result', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'read', { path: 'a.txt' })] }, { blocks: [text('it says alpha')] }]);
    const res = await runPrompt(opts, 'what is in a.txt');
    expect(res).toMatchObject({ subtype: 'success', numTurns: 2, result: 'it says alpha' });
    expect(kinds(log.events)).toEqual(['session', 'user', 'request', 'attempt', 'assistant', 'permission', 'tool_intent', 'tool_result', 'request', 'attempt', 'assistant', 'turn_end']);
    expect(of(log.events, 'tool_result')[0]!.output.text).toContain('alpha');
    expectPaired(log.events);
  });

  test('every result says where its time went, and attempts carry their timing', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'read', { path: 'a.txt' })] }, { blocks: [text('ok')] }]);
    const res = await runPrompt(opts, 'go');
    const t = res.timing!;
    for (const k of ['wallMs', 'modelMs', 'ttftMs', 'toolMs', 'harnessMs', 'outputTokPerSec'] as const) expect(typeof t[k]).toBe('number');
    expect(t.wallMs).toBeGreaterThanOrEqual(t.modelMs);
    for (const a of of(log.events, 'attempt')) expect(a).toMatchObject({ ttftMs: expect.any(Number), ms: expect.any(Number) });
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

    test('without declared checks the gate is off but the receipt still lists what is unverified', async () => {
      const { opts } = gate([{ blocks: [fixA(), run('touch made.txt')] }, { blocks: [text('done')] }]);
      const res = await runPrompt(opts, 'fix');
      expect(res.subtype).toBe('success');
      expect(res.evidence).toEqual({ changed: ['g.ts', 'bash: touch made.txt'], checks: [], unverified: ['g.ts', 'bash: touch made.txt'] });
    });

    test('a run that only reads needs no check and has no evidence', async () => {
      const { opts } = gate([{ blocks: [run('cat g.ts')] }, { blocks: [text('x is 1')] }], ['true']);
      const res = await runPrompt(opts, 'read');
      expect(res.subtype).toBe('success');
      expect(res.evidence).toBeUndefined();
    });
  });
});
