import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrompt, type RunOptions } from '../src/core/loop/run.ts';
import { FAUX_MODEL } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse, type FauxStep } from '../src/core/providers/faux.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { readTool } from '../src/core/tools/read.ts';
import type { ToolSpec } from '../src/core/tools/registry.ts';
import type { EventOf, Provider, SessionEvent, ToolEffect } from '../src/core/types.ts';

// The TUI runs every turn with streamingTools: these hold that path to what runTools does without it.

const WORKSPACE = { mode: 'workspace' as const, allow: [], deny: [] };
const of = <K extends SessionEvent['kind']>(events: SessionEvent[], k: K) => events.filter((e): e is EventOf<K> => e.kind === k);

// A provider that holds each reply's end back, so a call that starts early visibly starts before the reply ends.
function slowEnd(steps: FauxStep[], ms: number, mark: { endAt: number[] }): Provider {
  const p = fauxProvider(steps);
  return {
    ...p,
    async *stream(req, signal) {
      for await (const ev of p.stream(req, signal)) {
        if (ev.type === 'done') {
          await Bun.sleep(ms);
          mark.endAt.push(performance.now());
        }
        yield ev;
      }
    },
  };
}

// A tool that notes when each call starts and ends.
function probe(name: string, effect: ToolEffect, seen: { name: string; start: number; end: number }[], opts: { ms?: number; fail?: boolean } = {}): ToolSpec {
  return {
    name,
    description: name,
    schema: { type: 'object', properties: {} },
    effect,
    replay: 'safe',
    async run() {
      const start = performance.now();
      await Bun.sleep(opts.ms ?? 0);
      if (opts.fail) throw new Error(`${name} broke`);
      seen.push({ name, start, end: performance.now() });
      return { text: `${name} ok`, isError: false };
    },
  };
}

function setup(steps: FauxStep[] | Provider, extra: Partial<RunOptions> = {}) {
  const log = SessionLog.create();
  const opts: RunOptions = {
    log,
    provider: Array.isArray(steps) ? fauxProvider(steps) : steps,
    model: FAUX_MODEL,
    tools: [readTool, bashTool],
    system: 'sys',
    cwd: mkdtempSync(join(tmpdir(), 'cedia-stream-tools-')),
    permission: WORKSPACE,
    streamingTools: true,
    ...extra,
  };
  return { log, opts };
}

function expectPaired(events: SessionEvent[]) {
  const uses = of(events, 'assistant').flatMap((a) => a.blocks.flatMap((b) => (b.type === 'tool_use' ? [b.callId ?? b.id] : [])));
  expect(of(events, 'tool_result').map((r) => r.callId).sort()).toEqual(uses.sort());
  expect(lintSession(events)).toEqual([]);
}

describe('streaming tools', () => {
  test('a secret in a result is redacted before the log and the model see it', async () => {
    const token = `ghp_${'a1'.repeat(18)}`;
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'bash', { command: 'cat notes.txt' })] }, { blocks: [text('read it')] }]);
    writeFileSync(join(opts.cwd, 'notes.txt'), `token=${token}\n`);
    await runPrompt(opts, 'read notes');
    const result = of(log.events, 'tool_result')[0]!;
    expect(result.output.text).toContain('[cedia:redacted]');
    expect(JSON.stringify(log.events)).not.toContain(token);
    expectPaired(log.events);
  });

  test('writes of one reply run one at a time, in block order', async () => {
    const { log, opts } = setup([
      { blocks: [toolUse('c1', 'bash', { command: 'sleep 0.3; echo first >> order.txt' }), toolUse('c2', 'bash', { command: 'echo second >> order.txt' })] },
      { blocks: [text('done')] },
    ]);
    await runPrompt(opts, 'write');
    expect(readFileSync(join(opts.cwd, 'order.txt'), 'utf8')).toBe('first\nsecond\n');
    expectPaired(log.events);
  });

  test('a read starts while the reply still streams; a write waits for the reply', async () => {
    const seen: { name: string; start: number; end: number }[] = [];
    const mark = { endAt: [] as number[] };
    const provider = slowEnd([{ blocks: [toolUse('c1', 'look', {}), toolUse('c2', 'change', {})] }, { blocks: [text('done')] }], 200, mark);
    const { log, opts } = setup(provider, { tools: [probe('look', 'read', seen), probe('change', 'write_workspace', seen)] });
    await runPrompt(opts, 'go');
    const look = seen.find((s) => s.name === 'look')!;
    const change = seen.find((s) => s.name === 'change')!;
    expect(look.start).toBeLessThan(mark.endAt[0]!);
    expect(change.start).toBeGreaterThanOrEqual(mark.endAt[0]!);
    expectPaired(log.events);
  });

  test('a read after a write in the same reply waits for the write', async () => {
    const seen: { name: string; start: number; end: number }[] = [];
    const mark = { endAt: [] as number[] };
    const provider = slowEnd([{ blocks: [toolUse('c1', 'change', {}), toolUse('c2', 'look', {})] }, { blocks: [text('done')] }], 200, mark);
    const { log, opts } = setup(provider, { tools: [probe('look', 'read', seen), probe('change', 'write_workspace', seen, { ms: 100 })] });
    await runPrompt(opts, 'go');
    const look = seen.find((s) => s.name === 'look')!;
    const change = seen.find((s) => s.name === 'change')!;
    expect(look.start).toBeGreaterThanOrEqual(change.end);
    expectPaired(log.events);
  });

  test('a call the policy denies is never started early', async () => {
    const seen: { name: string; start: number; end: number }[] = [];
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'look', {})] }, { blocks: [text('done')] }], {
      tools: [probe('look', 'read', seen)],
      permission: { mode: 'workspace', allow: [], deny: ['look'] },
    });
    await runPrompt(opts, 'go');
    expect(seen).toEqual([]);
    expect(of(log.events, 'tool_result')[0]!.status).toBe('denied');
    expectPaired(log.events);
  });

  test('an early call that throws still gets its result', async () => {
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'look', {})] }, { blocks: [text('done')] }], { tools: [probe('look', 'read', [], { fail: true })] });
    await runPrompt(opts, 'go');
    const result = of(log.events, 'tool_result')[0]!;
    expect(result.status).toBe('failed');
    expect(result.output.text).toContain('look broke');
    expectPaired(log.events);
  });
});
