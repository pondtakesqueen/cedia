import { describe, expect, test } from "vitest";
import { emptyCompactionTracker, onCompact, onTurnStart, shouldCompact } from "../src/compaction.ts";

describe("compaction tracker", () => {
  test("allows compaction initially", () => {
    const t = emptyCompactionTracker();
    onTurnStart(t);
    expect(shouldCompact(t).allow).toBe(true);
  });

  test("detects rapid refill (3 compactions in <3 turns)", () => {
    const t = emptyCompactionTracker();
    // Turn 1: compact
    onTurnStart(t);
    onCompact(t);
    // Turn 2: compact (rapid)
    onTurnStart(t);
    onCompact(t);
    // Turn 3: compact (rapid) → should be blocked
    onTurnStart(t);
    const check = shouldCompact(t);
    expect(check.allow).toBe(false);
    expect(check.reason).toContain("thrashing");
  });

  test("resets after non-rapid compaction", () => {
    const t = emptyCompactionTracker();
    onTurnStart(t);
    onCompact(t);
    // Skip 3 turns
    onTurnStart(t);
    onTurnStart(t);
    onTurnStart(t);
    onCompact(t);
    onTurnStart(t);
    const check = shouldCompact(t);
    expect(check.allow).toBe(true);
  });
});