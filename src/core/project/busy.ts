import { spawnSync } from 'node:child_process';
import { isAlive } from './background.ts';
import type { Thread, ThreadStore } from './threads.ts';

// One run of a thread at a time. A thread can be driven from the TUI, the desktop, the daemon and `cedia -p
// --thread`, and its writer session's log takes one writer: two runs resuming the same session would both append
// to it. So a run that goes on with a thread whose last run has not ended asks the process that holds it first.
// The holder is the pid its `run` event names (absent before cedia recorded it, and then nothing is known to hold
// it). A pid that is gone, or that is now some other program (pids are reused), holds nothing: the run was killed
// and the thread is free. The same process holds nothing against itself (the TUI runs its turns one after another
// in one process).

export type Holder = { pid: number; run: string };

// The live process that holds the thread's last run, if one does.
export function holderOf(t: Thread, self = process.pid, alive: (pid: number) => boolean = isCediaProcess): Holder | undefined {
  if (!t.running) return undefined;
  const last = t.runs.at(-1);
  if (!last?.pid || last.pid === self || !alive(last.pid)) return undefined;
  return { pid: last.pid, run: last.id };
}

// A process that is alive and runs cedia (bin/cedia, or bun running it), so a reused pid is never taken for a run.
export function isCediaProcess(pid: number): boolean {
  if (!isAlive(pid)) return false;
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.status !== 0) return false;
  return /cedia|\bbun\b/.test(ps.stdout);
}

export type Claim = { ok: true; tookOver?: Holder } | { ok: false; error: string };

// Makes the thread free for a new run. Without `takeOver`, a held thread is refused. With it, the holder is sent
// SIGTERM, which ends its run as `stopped` the way Ctrl-C does, and this waits until that run wrote its state or the
// process is gone. One that does neither in `waitMs` keeps the thread: the run is refused rather than share the log.
export async function claimThread(store: ThreadStore, id: string, opts: { takeOver?: boolean; waitMs?: number; self?: number; alive?: (pid: number) => boolean; kill?: (pid: number) => void } = {}): Promise<Claim> {
  const alive = opts.alive ?? isCediaProcess;
  const holder = holderOf(store.read(id), opts.self, alive);
  if (!holder) return { ok: true };
  if (!opts.takeOver) return { ok: false, error: `thread ${id} is working: run ${holder.run} (pid ${holder.pid}) has not ended. Wait for it, send it a message with \`cedia threads send\`, or pass --take-over to stop it and go on` };
  try {
    (opts.kill ?? ((pid) => process.kill(pid, 'SIGTERM')))(holder.pid);
  } catch {}
  const until = Date.now() + (opts.waitMs ?? 15_000);
  while (Date.now() < until) {
    if (!holderOf(store.read(id), opts.self, alive)) return { ok: true, tookOver: holder };
    await Bun.sleep(100);
  }
  return { ok: false, error: `thread ${id}: run ${holder.run} (pid ${holder.pid}) did not stop within ${Math.round((opts.waitMs ?? 15_000) / 1000)}s` };
}
