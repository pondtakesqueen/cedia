import { expect, test } from 'bun:test';
import { bounded } from '../src/core/loop/run.ts';
import { spawnTool, type Spawner } from '../src/core/tools/spawn.ts';

const ctx = { cwd: '.', signal: new AbortController().signal };

test('explore sub-threads run at most four at a time, and a run starts at most sixteen', async () => {
  let running = 0;
  let peak = 0;
  const spawner: Spawner = async () => {
    peak = Math.max(peak, ++running);
    await Bun.sleep(10);
    running--;
    return { model: 'm', subtype: 'success', result: 'found it', costUsd: 0, changed: [], unverified: [] };
  };
  const tool = spawnTool(spawner);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => tool.run({ kind: 'explore', task: `look ${i}` }, ctx)));
  expect(peak).toBe(4);
  expect(results.filter((r) => !r.isError)).toHaveLength(16);
  expect(results.filter((r) => r.isError).map((r) => r.text)[0]).toContain('started 16 sub-threads, the most it may');
});

test('a sub-thread that throws gives its slot back', async () => {
  const tool = spawnTool(async () => {
    throw new Error('boom');
  }, { concurrent: 1, total: 5 });
  for (let i = 0; i < 3; i++) await expect(tool.run({ kind: 'explore', task: 'x' }, ctx)).rejects.toThrow('boom');
});

test('the parallel pool keeps at most its limit in flight and starts calls in order', async () => {
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  await bounded([...Array(20).keys()], 8, async (i) => {
    started.push(i);
    peak = Math.max(peak, ++running);
    await Bun.sleep(i % 3);
    running--;
  });
  expect([peak, started]).toEqual([8, [...Array(20).keys()]]);
  await bounded([], 8, async () => {});
});
