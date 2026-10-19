import { describe, expect, test } from "vitest";
import { crossedBudget, dayFile, parseRecords, type RequestRecord, statusLine, totals } from "../src/telemetry.ts";

const rec = (over: Partial<RequestRecord>): RequestRecord => ({
  ts: "", session: "s", provider: "p", model: "m", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, ms: 0, stopReason: "stop", ...over,
});

describe("totals", () => {
  test("cache hit counts cache reads against all prompt tokens", () => {
    const t = totals([rec({ input: 100, cacheRead: 800, cacheWrite: 100, costUsd: 0.5 }), rec({ costUsd: 0.25 })]);
    expect(t.costUsd).toBeCloseTo(0.75);
    expect(t.cacheHit).toBeCloseTo(0.8);
  });
  test("no prompt tokens means cache hit is unknown, not zero", () => {
    expect(totals([]).cacheHit).toBeUndefined();
  });
});

test("parseRecords skips blank and torn lines", () => {
  expect(parseRecords(`${JSON.stringify(rec({ costUsd: 1 }))}\n{"broken\n\n`)).toHaveLength(1);
});

test("statusLine shows session, today, the budget breach, and cache", () => {
  expect(statusLine({ costUsd: 1.234, cacheHit: 0.876 }, { costUsd: 21, cacheHit: 0.5 }, 20)).toBe("$1.23 session · $21.00 today (over $20) · cache 88%");
  expect(statusLine({ costUsd: 1, cacheHit: 1 }, { costUsd: 2, cacheHit: 1 }, 20, "opencode-go/beam-free")).toBe("$1.00 session · $2.00 today · cache 100% · opencode-go/beam-free");
});

test("crossedBudget fires once, on the request that crosses", () => {
  expect(crossedBudget(19, 20.5, 20)).toBe(true);
  expect(crossedBudget(20.5, 21, 20)).toBe(false);
  expect(crossedBudget(10, 11, 20)).toBe(false);
});

test("dayFile uses the local calendar day", () => {
  expect(dayFile(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05.jsonl");
});
