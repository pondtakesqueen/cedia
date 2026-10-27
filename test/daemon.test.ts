import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBgSessions, recordStart } from '../src/core/project/background.ts';
import { pumpDaemon } from '../src/core/project/daemon.ts';
import { schedulesPath, ScheduleStore } from '../src/core/project/schedules.ts';
import { threadsDir, ThreadStore } from '../src/core/project/threads.ts';

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'cedia-daemon-'));
  const slug = 'proj';
  const cwd = mkdtempSync(join(tmpdir(), 'cedia-daemon-ws-'));
  const threads = new ThreadStore(threadsDir(home, slug));
  const schedules = new ScheduleStore(schedulesPath(home, slug));
  const spawned: string[][] = [];
  // Fake children stay "alive": reuse this process's pid, so live() and the cap behave like production.
  const deps = { home, slug, cwd, maxRuns: 2, spawn: (argv: string[]) => (spawned.push(argv), process.pid) };
  return { home, slug, cwd, threads, schedules, spawned, deps };
};

describe('daemon pump', () => {
  test('starts queued threads (not archived, side, or already running) up to maxRuns', () => {
    const { threads, spawned, deps } = setup();
    const q1 = threads.open('first job', { by: 'coordinator' });
    const q2 = threads.open('second job', { by: 'coordinator' });
    const q3 = threads.open('third job', { by: 'coordinator' });
    const side = threads.open('side chat', { by: 'coordinator', side: true });
    const arch = threads.open('old job', { by: 'coordinator' });
    threads.append(arch, { kind: 'archived', archived: true });
    // list() order is newest-first (ties broken arbitrarily), so assert the set: any two of the three
    // queued threads start, and the third follows once there is room.
    const tick = pumpDaemon(deps);
    expect(tick.started).toHaveLength(2);
    const first = new Set(tick.started.map((s) => s.thread));
    expect([...first].every((t) => [q1, q2, q3].includes(t))).toBe(true);
    expect(spawned).toHaveLength(2);
    for (const argv of spawned) {
      expect(argv).toContain('--thread');
      expect(argv).toContain('-p');
    }
    expect(tick.running).toBe(2);
    // With the cap still reached, correctly nothing more starts; with room, the remaining queued one does —
    // never the side chat or the archived one.
    expect(pumpDaemon(deps).started).toEqual([]);
    const rest = [q1, q2, q3].find((t) => !first.has(t))!;
    const tick2 = pumpDaemon({ ...deps, maxRuns: 5 });
    expect(tick2.started.map((s) => s.thread)).toEqual([rest]);
    expect(spawned.flat().some((a) => a === side || a === arch)).toBe(false);
  });

  test('skips a queued thread a live run already works on, and reaps dead runs', () => {
    const { home, slug, threads, spawned, deps } = setup();
    const q = threads.open('job', { by: 'coordinator' });
    recordStart(home, slug, { id: 'bg-live', thread: q, pid: process.pid, logPath: '/tmp/x' });
    expect(pumpDaemon(deps).started).toEqual([]);
    expect(spawned).toEqual([]);
    recordStart(home, slug, { id: 'bg-dead', thread: 't-00000000', pid: 2147483647, logPath: '/tmp/y' });
    const tick = pumpDaemon({ ...deps, maxRuns: 5 });
    expect(tick.reaped).toEqual(['bg-dead']);
    expect(listBgSessions(home, slug).find((s) => s.id === 'bg-dead')?.stopped).toBe(true);
  });

  test('fires due schedules once (recording the run first) and runs their prompt on their thread', () => {
    const { threads, schedules, spawned, deps } = setup();
    const t = threads.open('scheduled work', {});
    const s = schedules.add({ prompt: 'nightly check', thread: t, first: new Date(Date.now() - 60_000), every: 60 });
    const tick = pumpDaemon(deps);
    expect(tick.fired).toHaveLength(1);
    expect(tick.fired[0]).toMatchObject({ schedule: s.id, thread: t });
    expect(schedules.list().find((x) => x.id === s.id)?.last).toBeDefined();
    const child = spawned.find((a) => a.includes(t))!;
    expect(child[child.indexOf('-p') + 1]).toBe('nightly check');
  });

  test('a paused schedule is left alone', () => {
    const { threads, schedules, spawned, deps } = setup();
    const t = threads.open('work', {});
    const s = schedules.add({ prompt: 'paused', thread: t, first: new Date(Date.now() - 60_000), every: 60 });
    schedules.setEnabled(s.id, false);
    expect(pumpDaemon(deps).fired).toEqual([]);
    expect(spawned).toEqual([]);
  });
});

describe('cedia daemon (offline)', () => {
  const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
  const run = (args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-daemon-cli-'));
    // Subcommand first: cli.ts dispatches on argv[0], each command parses its own --cwd.
    const p = Bun.spawnSync([BIN, ...args, '--cwd', dir], { env: { ...process.env, CEDIA_HOME: join(dir, 'home') }, stdin: 'ignore' });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };
  test('--once on an idle project starts nothing and says so', () => {
    const r = run(['daemon', '--once', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ daemon: 'once', started: [], fired: [], reaped: [], running: 0 });
  });
  test('status with no daemon, stop with no daemon, and an unknown subcommand', () => {
    expect(run(['daemon', 'status']).out).toBe('daemon: not running');
    expect(run(['daemon', 'stop']).code).toBe(1);
    expect(run(['daemon', 'bogus']).code).toBe(2);
  });
  test('spawnDetached starts a detached child and returns its pid', async () => {
    const { spawnDetached } = await import('../src/core/project/daemon.ts');
    const pid = spawnDetached([process.execPath, '--version']);
    expect(pid).toBeGreaterThan(0);
  });
});
