import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minutesOf, ScheduleStore, whenOf } from '../src/core/project/schedules.ts';
import { scheduleTool } from '../src/core/tools/schedule.ts';

const store = () => new ScheduleStore(join(mkdtempSync(join(tmpdir(), 'cedia-sched-')), 'schedules.jsonl'));
const at = (iso: string) => new Date(iso);
const ctx = { cwd: '/', signal: new AbortController().signal };

test('times and durations', () => {
  expect(minutesOf('30m')).toBe(30);
  expect(minutesOf('2h')).toBe(120);
  expect(minutesOf('1d')).toBe(1440);
  expect(minutesOf('1w')).toBe(10080);
  expect(minutesOf('soon')).toBeUndefined();
  const now = at('2026-10-22T12:00:00Z');
  expect(whenOf('30m', now)?.toISOString()).toBe('2026-10-22T12:30:00.000Z');
  expect(whenOf('in 2h', now)?.toISOString()).toBe('2026-10-22T14:00:00.000Z');
  expect(whenOf('2026-10-23T09:00:00+07:00', now)?.toISOString()).toBe('2026-10-23T02:00:00.000Z');
  expect(whenOf('tomorrow', now)).toBeUndefined();
});

test('a one-off is due once; a repeating one comes back on its grid, once however long the daemon slept', () => {
  const s = store();
  const once = s.add({ prompt: 'check the PR', thread: 't-00000001', first: at('2026-10-22T13:00:00Z') }, at('2026-10-22T12:00:00Z'));
  const daily = s.add({ prompt: 'check the nightly build', thread: 't-00000001', first: at('2026-10-23T02:00:00Z'), every: 1440 }, at('2026-10-22T12:00:00Z'));
  expect(s.due(at('2026-10-22T12:59:00Z'))).toEqual([]);
  expect(s.due(at('2026-10-22T13:00:00Z')).map((x) => x.id)).toEqual([once.id]);
  expect(s.fire(once.id, at('2026-10-22T13:00:05Z'))).toMatchObject({ last: '2026-10-22T13:00:05.000Z' });
  expect(s.get(once.id).next).toBeUndefined();
  expect(() => s.fire(once.id)).toThrow('is not due again');
  // Three days asleep: due once, then next on the grid after the run.
  expect(s.due(at('2026-10-25T05:00:00Z')).map((x) => x.id)).toEqual([daily.id]);
  s.fire(daily.id, at('2026-10-25T05:00:00Z'));
  expect(s.get(daily.id).next).toBe('2026-10-26T02:00:00.000Z');
  // Paused is never due; cancelled is gone.
  s.setEnabled(daily.id, false);
  expect(s.due(at('2026-10-27T00:00:00Z'))).toEqual([]);
  s.setEnabled(daily.id, true);
  expect(s.due(at('2026-10-27T00:00:00Z')).map((x) => x.id)).toEqual([daily.id]);
  s.cancel(daily.id);
  expect(s.list().map((x) => x.id)).toEqual([once.id]);
  expect(() => s.add({ prompt: 'x', thread: 't-00000001', first: new Date(), every: 1 })).toThrow('every 5 minutes at the most often');
  expect(() => s.add({ prompt: ' ', thread: 't-00000001', first: new Date() })).toThrow('needs a prompt');
});

test('the schedule tool adds, lists and cancels only its own thread\'s schedules', async () => {
  const s = store();
  const other = s.add({ prompt: 'not mine', thread: 't-00000002', first: new Date() });
  const tool = scheduleTool(s, 't-00000001');
  const added = await tool.run({ prompt: 'check the nightly build', at: '2026-10-23T09:00:00+07:00', every: '1d' }, ctx);
  expect(added.isError).toBe(false);
  expect(added.text).toMatch(/^Scheduled s-[0-9a-f]{8}\.\ns-[0-9a-f]{8}  next 2026-10-23T02:00:00.000Z  every 1440m  thread t-00000001  check the nightly build$/);
  expect((await tool.run({ prompt: 'x', at: 'whenever' }, ctx)).text).toContain('at must be an ISO time');
  expect((await tool.run({ prompt: 'x', at: '1h', every: '1m' }, ctx)).text).toContain('at least 5m');
  expect((await tool.run({ cancel: other.id }, ctx)).text).toStartWith(`No schedule ${other.id} on this thread.`);
  const id = s.list().find((x) => x.thread === 't-00000001')!.id;
  expect((await tool.run({ cancel: id }, ctx)).text).toBe(`Cancelled ${id}.\nThis thread has no schedules.`);
  expect(s.list().map((x) => x.id)).toEqual([other.id]);
});
