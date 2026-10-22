export type Settled<T> = { status: "fulfilled"; value: T; attempts: number } | { status: "rejected"; reason: unknown; attempts: number };

export interface PoolOptions {
  retries?: number;
  signal?: AbortSignal;
}

/**
 * Runs `tasks` with at most `limit` of them in flight at once, and resolves with one Settled per task, in the
 * order of `tasks` (not the order they finish in).
 *
 * Rules:
 * 1. `limit` is a whole number of 1 or more, or Infinity; anything else rejects with a RangeError before any
 *    task starts. `retries` (default 0) is a whole number of 0 or more, else a RangeError the same way.
 * 2. Tasks start in input order. A new task starts as soon as one in flight settles, so `limit` are in flight
 *    whenever that many are left to run, and never more.
 * 3. A task that throws synchronously, or returns something that is not a promise, counts the same as one
 *    that rejects or resolves with that value: a throw is a rejection, a plain value is a fulfilment.
 * 4. A rejected task is tried again right away in the same slot, up to `retries` more times. `attempts` is how
 *    many times the task was called in all (1 when it worked the first time).
 * 5. Once `signal` aborts, no task starts and no retry runs. Tasks in flight are left to settle and keep their
 *    result; a task that never started (attempts 0), and a task whose retry was cancelled, settle as rejected with
 *    `signal.reason`, the latter with the attempts it made. If the signal is already aborted at the call,
 *    no task starts.
 * 6. The returned promise resolves once every task has settled; it never rejects except for rule 1.
 */
export async function runPool<T>(tasks: Array<() => Promise<T> | T>, limit: number, opts: PoolOptions = {}): Promise<Settled<T>[]> {
  const retries = opts.retries ?? 0;
  if (!(limit >= 1)) throw new RangeError(`limit must be at least 1, got ${limit}`);
  if (retries < 0) throw new RangeError(`retries must be at least 0, got ${retries}`);

  const results: Settled<T>[] = [];
  let next = 0;
  let running = 0;

  return new Promise((resolve) => {
    if (tasks.length === 0) return resolve(results);

    const launch = () => {
      while (running <= limit && next < tasks.length) {
        if (opts.signal?.aborted) break;
        const index = next++;
        running++;
        attempt(index, 1);
      }
      if (next >= tasks.length && running === 0) resolve(results);
    };

    const attempt = (index: number, attempts: number) => {
      const done = (r: Settled<T>) => {
        results.push(r);
        running--;
        launch();
      };
      (tasks[index]() as Promise<T>).then(
        (value) => done({ status: "fulfilled", value, attempts }),
        (reason) => {
          if (attempts < retries) attempt(index, attempts + 1);
          else done({ status: "rejected", reason, attempts });
        },
      );
    };

    launch();
  });
}
