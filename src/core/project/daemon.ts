// The project daemon: whoever runs a project's queued threads and due schedules (the desktop's daemon,
// or cron with `cedia daemon --once`). One pump() pass reaps finished runs, starts queued threads and fires
// due schedules; `cedia daemon` repeats the pass, `--once` runs one. Children are cedia processes of their own
// (the compiled binary, or bun src/cli.ts in dev), detached, so a dead daemon never takes a run with it; all
// state stays in the thread, schedule and background files, which the next pass reads back.
import { cediaHome } from '../config.ts';
import { selfSpawnArgs } from '../self.ts';
import { projectKey, sessionPath } from '../session/log.ts';
import { daemonPid, daemonStart, daemonStop, isAlive, listBgSessions, recordStart, recordStop } from './background.ts';
import { schedulesPath, ScheduleStore } from './schedules.ts';
import { threadsDir, ThreadStore } from './threads.ts';

export type DaemonTick = {
  at: string;
  // Background ids whose process was gone and is now recorded stopped.
  reaped: string[];
  started: { bg: string; thread: string }[];
  fired: { schedule: string; thread: string; bg: string }[];
  running: number;
};

export type DaemonDeps = {
  home: string;
  slug: string;
  cwd: string;
  maxRuns: number;
  // Start a detached child; returns its pid. Production spawns cedia itself (spawnDetached); tests use a fake.
  spawn: (argv: string[]) => number;
};

// pump() is the whole daemon: pure except for the stores and spawn, so tests run it with a fake spawner.
export function pumpDaemon(deps: DaemonDeps): DaemonTick {
  const { home, slug, cwd, maxRuns } = deps;
  const tick: DaemonTick = { at: new Date().toISOString(), reaped: [], started: [], fired: [], running: 0 };
  const threads = new ThreadStore(threadsDir(home, slug));
  const schedules = new ScheduleStore(schedulesPath(home, slug));
  for (const s of listBgSessions(home, slug)) {
    if (!s.alive && !s.stopped) {
      recordStop(home, slug, s.id);
      tick.reaped.push(s.id);
    }
  }
  const live = () => listBgSessions(home, slug).filter((s) => s.alive && !s.stopped);
  const busy = new Set(live().map((s) => s.thread));
  const start = (prompt: string, thread: string) => {
    const bg = `bg-${crypto.randomUUID().slice(0, 8)}`;
    const pid = deps.spawn(selfSpawnArgs(['-p', prompt, '--thread', thread, '--sandbox', 'auto', '--output-format', 'json']));
    // The child's session id is its own; like `cedia -p --bg`, the path recorded is where its log would
    // land for a fresh session id, so `cedia logs` has something to open.
    recordStart(home, slug, { id: bg, thread, pid, logPath: sessionPath(cwd, crypto.randomUUID(), home) });
    busy.add(thread);
    return bg;
  };
  // Queued threads first: another thread opened them with open_thread and no run has started yet. Side chats
  // stay out: a side chat is forked for the owner to ask about, not for the daemon to run.
  for (const t of threads.list()) {
    if (live().length >= maxRuns) break;
    if (t.state !== 'queued' || t.archived || t.side || busy.has(t.id)) continue;
    tick.started.push({ bg: start(t.task, t.id), thread: t.id });
  }
  // Then schedules due now: firing first records the run, so a crash still moves a repeating grid on.
  for (const s of schedules.due()) {
    if (live().length >= maxRuns) break;
    if (busy.has(s.thread)) continue;
    schedules.fire(s.id);
    const bg = start(s.prompt, s.thread);
    tick.fired.push({ schedule: s.id, thread: s.thread, bg });
  }
  tick.running = live().length;
  return tick;
}

// Production spawner: a detached cedia child with stdio left behind, like `cedia -p --bg`.
export function spawnDetached(argv: string[]): number {
  const child = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  try {
    child.unref();
  } catch {}
  return child.pid ?? 0;
}

export const DEFAULT_INTERVAL_S = 30;
export const DEFAULT_MAX_RUNS = 2;

export const daemonPaths = (cwd: string, home = cediaHome()) => ({ home, slug: projectKey(cwd), cwd });

export function readDaemonPid(home = cediaHome()): number | null {
  const pid = daemonPid(home);
  return pid !== null && isAlive(pid) ? pid : null;
}

export { daemonStart, daemonStop };
