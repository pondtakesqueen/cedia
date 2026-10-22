import { expect, test } from "bun:test";
import { distinctInWindow, type Event } from "./window";

// The original, quadratic version: the oracle.
function oracle(events: Event[], windowMs: number): number[] {
  return events.map((e) => {
    const keys = new Set<string>();
    for (const o of events) if (o.t > e.t - windowMs && o.t <= e.t) keys.add(o.key);
    return keys.size;
  });
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

test("later entries with the same or an earlier time count", () => {
  const events = [
    { t: 10, key: "a" },
    { t: 10, key: "b" },
    { t: 3, key: "c" },
    { t: 10, key: "a" },
  ];
  expect(distinctInWindow(events, 10)).toEqual([3, 3, 1, 3]);
});

test("the window's start is open and its end closed", () => {
  const events = [
    { t: 0, key: "a" },
    { t: 10, key: "b" },
    { t: 10.5, key: "c" },
  ];
  expect(distinctInWindow(events, 10)).toEqual([1, 1, 2]);
  expect(distinctInWindow(events, 10.5)).toEqual([1, 2, 2]);
});

test("keys are exact strings, prototype names included", () => {
  const events = [
    { t: 1, key: "__proto__" },
    { t: 2, key: "constructor" },
    { t: 3, key: "" },
    { t: 4, key: "A" },
    { t: 5, key: "a" },
    { t: 6, key: "toString" },
    { t: 7, key: "__proto__" },
  ];
  expect(distinctInWindow(events, 100)).toEqual(oracle(events, 100));
});

test("negative, fractional and huge times", () => {
  const events = [
    { t: -5.5, key: "x" },
    { t: -1e15, key: "y" },
    { t: 1e15, key: "z" },
    { t: -5.25, key: "y" },
    { t: 0, key: "x" },
  ];
  for (const w of [0.25, 1, 6, 1e15, 3e15]) expect(distinctInWindow(events, w)).toEqual(oracle(events, w));
});

test("bad input is refused the same way", () => {
  for (const w of [0, -1, NaN, Infinity]) expect(() => distinctInWindow([{ t: 1, key: "a" }], w)).toThrow(RangeError);
  expect(() => distinctInWindow([{ t: 1, key: "a" }, { t: NaN, key: "b" }, { t: Infinity, key: "c" }], 5)).toThrow(/\b1\b/);
  expect(() => distinctInWindow([{ t: 1, key: "a" }, { t: Infinity, key: "c" }], 5)).toThrow(TypeError);
  expect(() => distinctInWindow([{ t: "3" as unknown as number, key: "a" }], 5)).toThrow(TypeError);
  expect(() => distinctInWindow([], -1)).toThrow(RangeError);
});

test("does not change its input", () => {
  const events = [
    { t: 3, key: "a" },
    { t: 1, key: "b" },
    { t: 2, key: "c" },
  ];
  const copy = JSON.parse(JSON.stringify(events));
  distinctInWindow(events, 2);
  expect(events).toEqual(copy);
});

test("matches the original on random input", () => {
  const r = rng(7);
  for (let round = 0; round < 300; round++) {
    const n = Math.floor(r() * 60);
    const span = [5, 50, 1000][round % 3];
    const keys = 1 + Math.floor(r() * 8);
    const events = Array.from({ length: n }, () => ({ t: Math.floor(r() * span) / (round % 4 === 0 ? 4 : 1), key: `k${Math.floor(r() * keys)}` }));
    const w = [0.5, 1, 3, 10, 400][round % 5];
    expect(distinctInWindow(events, w)).toEqual(oracle(events, w));
  }
});

test("200,000 events in under a second", () => {
  const r = rng(42);
  const events = Array.from({ length: 200_000 }, () => ({ t: Math.floor(r() * 5_000_000), key: `user-${Math.floor(r() * 20_000)}` }));
  // A tenth first, so a slow version fails in seconds instead of running for minutes.
  const warm = performance.now();
  distinctInWindow(events.slice(0, 20_000), 60_000);
  expect(performance.now() - warm).toBeLessThan(200);
  const start = performance.now();
  const out = distinctInWindow(events, 60_000);
  const ms = performance.now() - start;
  expect(out.length).toBe(200_000);
  expect(ms).toBeLessThan(1000);
  // Spot-check a few against the oracle's rule.
  for (const i of [0, 777, 123_456, 199_999]) {
    const e = events[i];
    const keys = new Set<string>();
    for (const o of events) if (o.t > e.t - 60_000 && o.t <= e.t) keys.add(o.key);
    expect(out[i]).toBe(keys.size);
  }
}, 30_000);
