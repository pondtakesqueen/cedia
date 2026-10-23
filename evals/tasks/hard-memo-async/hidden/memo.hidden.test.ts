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

test("a hit makes a key the most recently used", async () => {
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 1000, max: 2 });
  m("a");
  m("b");
  for (const c of calls) c.d.resolve(c.key);
  await tick();
  expect(await m("a")).toBe("a");
  m("c");
  expect(calls).toHaveLength(3);
  expect(await m("a")).toBe("a");
  expect(calls).toHaveLength(3);
  m("b");
  expect(calls).toHaveLength(4);
});

test("an earlier call's rejection does not drop the call after invalidate", async () => {
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 1000, max: 10 });
  const first = m("k");
  m.invalidate("k");
  const second = m("k");
  calls[0]!.d.reject(new Error("old"));
  await expect(first).rejects.toThrow("old");
  calls[1]!.d.resolve("new");
  expect(await second).toBe("new");
  expect(await m("k")).toBe("new");
  expect(calls).toHaveLength(2);
});

test("an earlier call's result does not replace the call after invalidate", async () => {
  let t = 0;
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 100, max: 10, now: () => t });
  m("k");
  m.invalidate("k");
  const second = m("k");
  calls[0]!.d.resolve("old");
  await tick();
  expect(m("k")).toBe(second);
  calls[1]!.d.resolve("new");
  expect(await m("k")).toBe("new");
  expect(calls).toHaveLength(2);
});

test("a key dropped for max while in flight is not kept when it settles", async () => {
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 1000, max: 1 });
  const a = m("a");
  m("b");
  calls[0]!.d.resolve("a");
  expect(await a).toBe("a");
  await tick();
  expect(m.size).toBe(1);
  m("a");
  expect(calls).toHaveLength(3);
});

test("a rejection reaches every waiting caller and is not kept", async () => {
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 1000, max: 10 });
  const a = m("k");
  const b = m("k");
  calls[0]!.d.reject(new Error("down"));
  await expect(a).rejects.toThrow("down");
  await expect(b).rejects.toThrow("down");
  m("k");
  expect(calls).toHaveLength(2);
});

test("a call in flight does not expire, and its ttl starts when it settles", async () => {
  let t = 0;
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 100, max: 10, now: () => t });
  const a = m("k");
  t = 500;
  expect(m("k")).toBe(a);
  calls[0]!.d.resolve("v");
  await tick();
  t = 599;
  expect(await m("k")).toBe("v");
  expect(calls).toHaveLength(1);
});

test("clear forgets every key, in flight or settled", async () => {
  const { fn, calls } = lookups();
  const m = memo(fn, { ttlMs: 1000, max: 10 });
  m("a");
  const b = m("b");
  calls[0]!.d.resolve("a");
  await tick();
  m.clear();
  expect(m.size).toBe(0);
  calls[1]!.d.resolve("b");
  expect(await b).toBe("b");
  await tick();
  expect(m.size).toBe(0);
  m("a");
  m("b");
  expect(calls).toHaveLength(4);
});

test("bad options are a RangeError", () => {
  const fn = async (k: string) => k;
  expect(() => memo(fn, { ttlMs: 0, max: 1 })).toThrow(RangeError);
  expect(() => memo(fn, { ttlMs: 1, max: 0 })).toThrow(RangeError);
  expect(() => memo(fn, { ttlMs: 1, max: 1.5 })).toThrow(RangeError);
});
