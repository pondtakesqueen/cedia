import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrompt, type RunOptions } from '../src/core/loop/run.ts';
import { FAUX_MODEL } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, type FauxStep } from '../src/core/providers/faux.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { readTool } from '../src/core/tools/read.ts';
import { spawnTool } from '../src/core/tools/spawn.ts';
import type { SpawnOutcome } from '../src/core/tools/spawn.ts';

const cwd = mkdtempSync(join(tmpdir(), 'cedia-wave2-'));

function setup(steps: FauxStep[], extra: Partial<RunOptions> = {}) {
  const log = SessionLog.create();
  const sleeps: number[] = [];
  const opts: RunOptions = {
    log,
    provider: fauxProvider(steps),
    model: FAUX_MODEL,
    tools: [readTool, bashTool],
    system: 'sys',
    cwd,
    retry: { sleep: async (ms) => void sleeps.push(ms) },
    ...extra,
  };
  return { log, opts, sleeps };
}

describe('a run that stays open says what it waits for (2.1.296)', () => {
  test('onWait hears a capped backoff before it sleeps, and stays silent for short ones', async () => {
    const err: FauxStep = { error: { code: 'server', status: 500, message: 'boom' } };
    const heard: number[] = [];
    const { opts } = setup([err, err, { blocks: [text('ok')] }], { retry: { max: 8, baseMs: 20_000, sleep: async () => {} }, onWait: (ms) => void heard.push(ms) });
    const res = await runPrompt(opts, 'hi');
    expect(res.subtype).toBe('success');
    // n=1 waits 20s (silent), n=2 waits the 30s cap (said).
    expect(heard).toEqual([30_000]);
  });
});

describe('a sub-thread hands off on its own window (autoCompactWindow)', () => {
  const ok: SpawnOutcome = { model: 'm', subtype: 'success', result: 'done', costUsd: 0, changed: [], unverified: [] };
  const seen: unknown[] = [];
  const tool = spawnTool(async (_task, _kind, ctx) => (seen.push({ ...ctx, signal: undefined }), ok));
  const ctx = { cwd, signal: AbortSignal.timeout(5000) };

  test('handoffAt under 1000 tokens or fractional is refused', async () => {
    for (const handoffAt of [999, 1.5, -100]) {
      const r = await tool.run({ task: 't', kind: 'explore', handoffAt }, ctx as never);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('handoffAt must be a token count of at least 1000');
    }
    expect(seen).toEqual([]);
  });

  test('a valid handoffAt reaches the spawner; absent stays absent', async () => {
    await tool.run({ task: 't', kind: 'explore', handoffAt: 20_000 }, ctx as never);
    await tool.run({ task: 't', kind: 'explore' }, ctx as never);
    expect(seen).toEqual([{ handoffAt: 20_000 }, {}]);
  });
});
