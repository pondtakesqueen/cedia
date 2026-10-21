import { describe, expect, test } from "bun:test";
import { checkLedgerIdentity, claimsDone, loadTasks, splitCommand } from "../evals/run.ts";

describe("evals runner", () => {
  test("splitCommand keeps quoted arguments together", () => {
    expect(splitCommand(`node -e "console.log('a b')" x`)).toEqual(["node", "-e", "console.log('a b')", "x"]);
  });

  test("ledger identity holds for one rollout and one verify per task", () => {
    const entries = [
      { kind: "rollout" as const, label: "a:harness", ms: 1 },
      { kind: "session" as const, label: "a:verify", ms: 1 },
    ];
    expect(() => checkLedgerIdentity(entries, 1)).not.toThrow();
    expect(() => checkLedgerIdentity([...entries, entries[0]!], 1)).toThrow(/budget identity broken/);
  });

  test("claimsDone is a keyword signal", () => {
    expect(claimsDone("All tests passing.")).toBe(true);
    expect(claimsDone("I could not finish.")).toBe(false);
  });

  test("every task file has an id, a prompt and a verify command", () => {
    const tasks = loadTasks(new URL("../evals/tasks", import.meta.url).pathname);
    expect(tasks.length).toBe(12);
    for (const t of tasks) {
      expect(t.id).toBeTruthy();
      expect(t.prompt).toBeTruthy();
      expect(t.verify).toBeTruthy();
    }
  });
});
