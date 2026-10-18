import { describe, expect, test } from "vitest";
import { emptyGoalState, goalStatus, startGoal, stopGoal } from "../src/goal.ts";

describe("goal state", () => {
  test("empty state is inactive", () => {
    const s = emptyGoalState();
    expect(s.active).toBe(false);
    expect(goalStatus(s)).toBe("No active goal.");
  });

  test("startGoal activates with outcome and round 0", () => {
    const s = emptyGoalState();
    startGoal(s, "all tests pass", 5);
    expect(s.active).toBe(true);
    expect(s.outcome).toBe("all tests pass");
    expect(s.round).toBe(0);
    expect(s.lastCheckIndex).toBe(5);
    expect(s.startLedgerIndex).toBe(5);
    expect(goalStatus(s)).toContain("all tests pass");
  });

  test("stopGoal deactivates", () => {
    const s = emptyGoalState();
    startGoal(s, "x", 0);
    stopGoal(s);
    expect(s.active).toBe(false);
    expect(goalStatus(s)).toBe("No active goal.");
  });
});