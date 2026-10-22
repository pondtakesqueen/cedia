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
  if (!(limit === Infinity || (Number.isInteger(limit) && limit >= 1))) throw new RangeError(`limit must be a whole number of at least 1, got ${limit}`);
  if (!(Number.isInteger(retries) && retries >= 0)) throw new RangeError(`retries must be a whole number of at least 0, got ${retries}`);

  const results: Settled<T>[] = new Array(tasks.length);
  const signal = opts.signal;
  let next = 0;
  let running = 0;
  let left = tasks.length;

  return new Promise((resolve) => {
    if (left === 0) return resolve(results);

    const settle = (index: number, r: Settled<T>) => {
      results[index] = r;
      if (--left === 0) resolve(results);
    };

    const launch = () => {
      if (signal?.aborted) {
        while (next < tasks.length) settle(next++, { status: "rejected", reason: signal.reason, attempts: 0 });
        return;
      }
      while (running < limit && next < tasks.length) {
        running++;
        attempt(next++, 1);
      }
    };

    const attempt = (index: number, attempts: number) => {
      const finish = (r: Settled<T>) => {
        running--;
        settle(index, r);
        launch();
      };
      let p: Promise<T>;
      try {
        p = Promise.resolve(tasks[index]());
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(
        (value) => finish({ status: "fulfilled", value, attempts }),
        (reason) => {
          if (attempts > retries) finish({ status: "rejected", reason, attempts });
          else if (signal?.aborted) finish({ status: "rejected", reason: signal.reason, attempts });
          else attempt(index, attempts + 1);
        },
      );
    };

    signal?.addEventListener("abort", launch, { once: true });
    launch();
  });
}
