import { expect, test } from "bun:test";
import { runPool } from "./pool";

// A task whose settling the test controls, counting how many run at once.
function gate() {
  let inFlight = 0;
  let peak = 0;
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void; id: number }> = [];
  const make = (id: number) => () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise((resolve, reject) => {
      pending.push({
        id,
        resolve: (v) => { inFlight--; resolve(v); },
        reject: (e) => { inFlight--; reject(e); },
      });
    });
  };
  return { make, pending, peak: () => peak, inFlight: () => inFlight };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("never more than the limit in flight, and refills at once", async () => {
  const g = gate();
  const done = runPool(Array.from({ length: 7 }, (_, i) => g.make(i)), 3);
  await tick();
  expect(g.inFlight()).toBe(3);
  expect(g.pending.map((p) => p.id)).toEqual([0, 1, 2]);
  g.pending.find((p) => p.id === 1)!.resolve("one");
  await tick();
  expect(g.inFlight()).toBe(3);
  expect(g.pending.map((p) => p.id)).toEqual([0, 1, 2, 3]);
  for (let round = 0; round < 10; round++) {
    for (const p of [...g.pending]) p.resolve(p.id);
    g.pending.length = 0;
    await tick();
  }
  const out = await done;
  expect(g.peak()).toBe(3);
  expect(out.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([0, "one", 2, 3, 4, 5, 6]);
});

test("results are in input order, not finishing order", async () => {
  const delays = [30, 5, 20, 1, 10];
  const out = await runPool(delays.map((d, i) => () => new Promise((r) => setTimeout(() => r(i), d))), 2);
  expect(out.map((r) => (r as { value: number }).value)).toEqual([0, 1, 2, 3, 4]);
});

test("a limit of 1 runs one at a time", async () => {
  const g = gate();
  const done = runPool([g.make(0), g.make(1), g.make(2)], 1);
  for (let i = 0; i < 3; i++) {
    await tick();
    expect(g.inFlight()).toBe(1);
    g.pending.shift()!.resolve(i);
  }
  expect((await done).map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
  expect(g.peak()).toBe(1);
});

test("Infinity starts everything", async () => {
  const g = gate();
  const done = runPool(Array.from({ length: 50 }, (_, i) => g.make(i)), Infinity);
  await tick();
  expect(g.inFlight()).toBe(50);
  for (const p of g.pending) p.resolve(1);
  expect((await done).length).toBe(50);
});

test("bad limits and retries reject with RangeError before any task starts", async () => {
  let started = 0;
  const t = () => { started++; return Promise.resolve(1); };
  for (const limit of [0, -1, 1.5, NaN]) await expect(runPool([t], limit)).rejects.toBeInstanceOf(RangeError);
  for (const retries of [-1, 0.5, NaN]) await expect(runPool([t], 2, { retries })).rejects.toBeInstanceOf(RangeError);
  expect(started).toBe(0);
});

test("a synchronous throw is a rejection and frees its slot", async () => {
  const boom = new Error("boom");
  const out = await runPool<number>([() => { throw boom; }, () => Promise.resolve(2), () => { throw boom; }, () => Promise.resolve(4)], 1);
  expect(out).toEqual([
    { status: "rejected", reason: boom, attempts: 1 },
    { status: "fulfilled", value: 2, attempts: 1 },
    { status: "rejected", reason: boom, attempts: 1 },
    { status: "fulfilled", value: 4, attempts: 1 },
  ]);
});

test("a plain return value is a fulfilment", async () => {
  const out = await runPool<number | undefined>([() => 7, () => undefined], 2);
  expect(out).toEqual([
    { status: "fulfilled", value: 7, attempts: 1 },
    { status: "fulfilled", value: undefined, attempts: 1 },
  ]);
});

test("retries run up to `retries` more times and count attempts", async () => {
  let calls = 0;
  const flaky = () => { calls++; return calls < 3 ? Promise.reject(new Error(`no ${calls}`)) : Promise.resolve("yes"); };
  expect(await runPool([flaky], 1, { retries: 2 })).toEqual([{ status: "fulfilled", value: "yes", attempts: 3 }]);

  let n = 0;
  const never = () => { n++; return Promise.reject(new Error(`fail ${n}`)); };
  const [r] = await runPool([never], 1, { retries: 2 });
  expect(n).toBe(3);
  expect(r).toEqual({ status: "rejected", reason: new Error("fail 3"), attempts: 3 });

  let m = 0;
  const once = () => { m++; return Promise.reject(new Error("x")); };
  expect((await runPool([once], 1))[0].attempts).toBe(1);
  expect(m).toBe(1);
});

test("a retry keeps its slot: the limit holds while tasks retry", async () => {
  let inFlight = 0;
  let peak = 0;
  const task = (fails: number) => {
    let left = fails;
    return () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve, reject) => setTimeout(() => { inFlight--; left-- > 0 ? reject(new Error("again")) : resolve("ok"); }, 2));
    };
  };
  const out = await runPool([task(2), task(0), task(1), task(3), task(0)], 2, { retries: 3 });
  expect(peak).toBe(2);
  expect(out.map((r) => r.attempts)).toEqual([3, 1, 2, 4, 1]);
});

test("abort: nothing new starts, running tasks keep their results, the rest reject with the reason", async () => {
  const g = gate();
  const ac = new AbortController();
  const done = runPool(Array.from({ length: 5 }, (_, i) => g.make(i)), 2, { signal: ac.signal });
  await tick();
  expect(g.pending.map((p) => p.id)).toEqual([0, 1]);
  const reason = new Error("stop");
  ac.abort(reason);
  await tick();
  g.pending[0].resolve("zero");
  g.pending[1].resolve("one");
  await tick();
  expect(g.pending.map((p) => p.id)).toEqual([0, 1]);
  const out = await done;
  expect(out).toEqual([
    { status: "fulfilled", value: "zero", attempts: 1 },
    { status: "fulfilled", value: "one", attempts: 1 },
    { status: "rejected", reason, attempts: 0 },
    { status: "rejected", reason, attempts: 0 },
    { status: "rejected", reason, attempts: 0 },
  ]);
});

test("abort resolves even when every slot is still busy", async () => {
  const g = gate();
  const ac = new AbortController();
  const done = runPool(Array.from({ length: 3 }, (_, i) => g.make(i)), 1, { signal: ac.signal });
  await tick();
  ac.abort("bye");
  await tick();
  g.pending[0].resolve(0);
  const out = await done;
  expect(out.map((r) => r.status)).toEqual(["fulfilled", "rejected", "rejected"]);
});

test("abort stops a pending retry", async () => {
  const ac = new AbortController();
  let calls = 0;
  const failing = () => { calls++; return new Promise((_, reject) => setTimeout(() => { ac.abort("halt"); reject(new Error("bad")); }, 2)); };
  const out = await runPool([failing], 1, { retries: 5, signal: ac.signal });
  expect(calls).toBe(1);
  expect(out).toEqual([{ status: "rejected", reason: "halt", attempts: 1 }]);
});

test("an already aborted signal starts nothing", async () => {
  const ac = new AbortController();
  ac.abort("early");
  let started = 0;
  const out = await runPool([() => { started++; return 1; }, () => { started++; return 2; }], 2, { signal: ac.signal });
  expect(started).toBe(0);
  expect(out).toEqual([
    { status: "rejected", reason: "early", attempts: 0 },
    { status: "rejected", reason: "early", attempts: 0 },
  ]);
});
