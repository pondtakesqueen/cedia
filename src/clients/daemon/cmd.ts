// `cedia daemon`: run a project's queued threads and due schedules, in cedia processes of their own.
// One `--once` pass suits cron; the foreground loop suits the desktop's daemon. State stays in the
// thread, schedule and background files, so stopping the daemon never stops a run.
import { parseArgs } from 'node:util';
import { DEFAULT_INTERVAL_S, DEFAULT_MAX_RUNS, daemonPaths, daemonStart, daemonStop, pumpDaemon, readDaemonPid, spawnDetached } from '../../core/project/daemon.ts';
import { daemonPid } from '../../core/project/background.ts';

export async function daemonCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === 'stop') {
    const pid = daemonPid();
    if (pid === null) {
      console.error('cedia: no daemon running (no daemon.pid)');
      return 1;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      console.error(`cedia: cannot stop ${pid}: ${(e as Error).message}`);
      return 1;
    }
    console.log(`stopped ${pid}`);
    return 0;
  }
  if (sub === 'status') {
    const pid = readDaemonPid();
    console.log(pid === null ? 'daemon: not running' : `daemon: running as ${pid}`);
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: sub === undefined || sub.startsWith('--') ? argv : rest, allowPositionals: true, options: { once: { type: 'boolean' }, interval: { type: 'string' }, max: { type: 'string' }, cwd: { type: 'string' }, json: { type: 'boolean' } } });
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    return 2;
  }
  if ((sub !== undefined && !sub.startsWith('--')) || parsed.positionals.length) {
    console.error('usage: cedia daemon [stop | status | [--once] [--interval <s>] [--max <n>] [--cwd <dir>] [--json]]');
    return 2;
  }
  const { home, slug, cwd } = daemonPaths(parsed.values.cwd ?? process.cwd());
  const maxRuns = Number(parsed.values.max ?? DEFAULT_MAX_RUNS);
  if (!Number.isFinite(maxRuns) || maxRuns < 1) {
    console.error(`--max takes a positive number: ${parsed.values.max}`);
    return 2;
  }
  const interval = Number(parsed.values.interval ?? DEFAULT_INTERVAL_S);
  if (!Number.isFinite(interval) || interval <= 0) {
    console.error(`--interval takes seconds above 0: ${parsed.values.interval}`);
    return 2;
  }
  const show = (prefix: string, tick: { reaped: string[]; started: { bg: string; thread: string }[]; fired: { schedule: string; thread: string; bg: string }[]; running: number }) =>
    console.log(parsed.values.json ? JSON.stringify({ daemon: prefix, ...tick }) : `${prefix}: ${tick.started.length} started, ${tick.fired.length} fired, ${tick.reaped.length} reaped, ${tick.running} running`);
  if (parsed.values.once) {
    show('once', await pumpDaemon({ home, slug, cwd, maxRuns, spawn: spawnDetached }));
    return 0;
  }
  daemonStart();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (;;) {
      show('tick', await pumpDaemon({ home, slug, cwd, maxRuns, spawn: spawnDetached }));
      for (let waited = 0; waited < interval && !stopped; waited++) await Bun.sleep(1000);
      if (stopped) break;
    }
  } finally {
    daemonStop();
  }
  return 0;
}
