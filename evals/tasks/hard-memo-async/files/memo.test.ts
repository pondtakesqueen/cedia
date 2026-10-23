import { expect, test } from "bun:test";
import { memo } from "./memo";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

// fn's calls, each settled by the test.
function lookups() {
  const calls: { key: string; d: ReturnType<typeof deferred<string>> }[] = [];
  const fn = (key: string) => {
    const d = deferred<string>();
    calls.push({ key, d });
    return d.promise;
  };
  return { fn, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("calls in flight for a key share one lookup", async () => {
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 1000, max: 10 });
  const a = m("k");
  const b = m("k");
  expect(calls).toHaveLength(1);
  calls[0]!.d.resolve("v");
  expect(await a).toBe("v");
  expect(await b).toBe("v");
});

test("a result expires ttlMs after it settled", async () => {
  let t = 0;
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 100, max: 10, now: () => t });
  m("k");
  calls[0]!.d.resolve("v");
  await tick();
  t = 99;
  expect(await m("k")).toBe("v");
  t = 100;
  m("k");
  expect(calls).toHaveLength(2);
});

test("never keeps more than max keys", async () => {
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 1000, max: 2 });
  for (const k of ["a", "b", "c", "d"]) m(k);
  expect(m.size).toBe(2);
  for (const c of calls) c.d.resolve(c.key);
  await tick();
  expect(m.size).toBe(2);
});

test("a result in flight during invalidate is not kept", async () => {
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 1000, max: 10 });
  const first = m("k");
  m.invalidate("k");
  calls[0]!.d.resolve("old");
  expect(await first).toBe("old");
  m("k");
  expect(calls).toHaveLength(2);
});
