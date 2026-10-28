import { expect, test } from "bun:test";
import { nextRun } from "./cron";

const at = (iso: string) => new Date(iso);

test("every minute", () => {
  expect(nextRun("* * * * *", at("2026-01-01T00:00:00Z")).toISOString()).toBe("2026-01-01T00:01:00.000Z");
});

test("a daily time", () => {
  expect(nextRun("30 9 * * *", at("2026-01-01T10:00:00Z")).toISOString()).toBe("2026-01-02T09:30:00.000Z");
});

test("weekdays", () => {
  expect(nextRun("0 8 * * 1-5", at("2026-01-02T09:00:00Z")).toISOString()).toBe("2026-01-05T08:00:00.000Z");
});

test("a wrong number of fields", () => {
  expect(() => nextRun("* * *", at("2026-01-01T00:00:00Z"))).toThrow(RangeError);
});
