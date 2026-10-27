import { expect, test } from 'bun:test';
import { bounded } from '../src/core/loop/run.ts';
import { spawnReport, spawnTool, type Spawner } from '../src/core/tools/spawn.ts';

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

test('a report names the files written whole by a tool, and whose version was kept', () => {
  const report = spawnReport('work', {
    model: 'm',
    subtype: 'success',
    result: 'done',
    costUsd: 0,
    changed: ['bun.lock', 'gen/api.ts'],
    unverified: [],
    worktree: { applied: ['bun.lock'], refused: [], conflicts: [], newest: [{ file: 'bun.lock', kept: 'its' }, { file: 'gen/api.ts', kept: 'yours' }] },
  });
  expect(report).toContain('Both of you changed bun.lock, gen/api.ts, which a tool writes whole');
  expect(report).toContain('(bun.lock: its, gen/api.ts: yours)');
});

test('best of N: approaches go to the spawner with worktrees on, count one sub-thread each, and are checked', async () => {
  const seen: (string[] | undefined)[] = [];
  const spawner: Spawner = async (_task, _kind, c) => {
    seen.push(c.approaches);
    return { model: 'm', subtype: 'success', result: 'ok', costUsd: 0, changed: [], unverified: [] };
  };
  const write = <T>(fn: () => Promise<T> | T) => Promise.resolve(fn());
  const tool = spawnTool(spawner, { concurrent: 4, total: 4 }, { worktrees: true });
  expect(JSON.stringify(tool.schema)).toContain('approaches');
  expect((await tool.run({ kind: 'explore', task: 'x', approaches: ['a', 'b'] }, ctx)).text).toBe('approaches is for kind "work" only');
  expect((await tool.run({ kind: 'work', task: 'x', approaches: ['a'] }, { ...ctx, write })).text).toBe('approaches takes 2 to 4 different approaches');
  expect((await tool.run({ kind: 'work', task: 'x', approaches: ['a', 'b', 'c'] }, { ...ctx, write })).isError).toBe(false);
  expect(seen).toEqual([['a', 'b', 'c']]);
  // Three of four started: two more would pass the limit.
  expect((await tool.run({ kind: 'work', task: 'x', approaches: ['a', 'b'] }, { ...ctx, write })).text).toContain('and 2 more would pass 4');
  // Without worktrees there is no such input.
  const plain = spawnTool(spawner);
  expect(JSON.stringify(plain.schema)).not.toContain('approaches');
});

test('spawn takes an effort level for the sub-thread and refuses an unknown one', async () => {
  const seen: (string | undefined)[] = [];
  const spawner: Spawner = async (_task, _kind, c) => {
    seen.push(c.effort);
    return { model: 'm', subtype: 'success', result: 'ok', costUsd: 0, changed: [], unverified: [] };
  };
  const tool = spawnTool(spawner);
  expect(JSON.stringify(tool.schema.properties)).toContain('effort');
  expect((await tool.run({ kind: 'explore', task: 'x', effort: 'high' }, ctx)).isError).toBe(false);
  expect((await tool.run({ kind: 'explore', task: 'x' }, ctx)).isError).toBe(false);
  expect((await tool.run({ kind: 'explore', task: 'x', effort: 'ultra' }, ctx)).text).toBe('effort must be one of low, medium, high, xhigh, max');
  expect(seen).toEqual(['high', undefined]);
});

test('subtask briefs say time matters: earlier correct reports beat polish', async () => {
  const { subtaskPrompt } = await import('../src/core/tools/spawn.ts');
  const brief = subtaskPrompt('find it', 't-12345678', 'explore');
  expect(brief).toContain('Time matters');
  expect(brief).toContain('of thread t-12345678');
});
