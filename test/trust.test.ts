import { describe, expect, test } from "vitest";
import { claimNudge, detectClaims, emptyLedger, isCheckCommand, ledgerStatus, markInput, receipt, recordToolResult } from "../src/trust.ts";

describe("isCheckCommand", () => {
  test.each(["npm test", "npm run lint", "npx vitest run", "cargo test -p core", "pytest -q", "go test ./..."])("%s is a check", (cmd) => {
    expect(isCheckCommand(cmd)).toBe(true);
  });
  test.each(["ls -la", "cat package.json", "git status", "echo test"])("%s is not a check", (cmd) => {
    expect(isCheckCommand(cmd)).toBe(false);
  });
});

describe("ledger", () => {
  test("a change after the last passing check is unverified", () => {
    const ledger = emptyLedger();
    recordToolResult(ledger, "edit", { path: "a.ts" }, false, undefined);
    recordToolResult(ledger, "bash", { command: "npm test" }, false, 0);
    recordToolResult(ledger, "write", { path: "b.ts" }, false, undefined);
    expect(ledgerStatus(ledger).unverified).toEqual(["b.ts"]);
  });

  test("a failing check does not verify earlier changes", () => {
    const ledger = emptyLedger();
    recordToolResult(ledger, "edit", { path: "a.ts" }, false, undefined);
    recordToolResult(ledger, "bash", { command: "npm test" }, true, 1);
    expect(ledgerStatus(ledger).unverified).toEqual(["a.ts"]);
  });

  test("a failed edit is not a change", () => {
    const ledger = emptyLedger();
    recordToolResult(ledger, "edit", { path: "a.ts" }, true, undefined);
    expect(ledgerStatus(ledger).changed).toEqual([]);
  });

  test("changes and checks are scoped to the latest input, unverified spans inputs", () => {
    const ledger = emptyLedger();
    recordToolResult(ledger, "edit", { path: "old.ts" }, false, undefined);
    markInput(ledger);
    recordToolResult(ledger, "edit", { path: "new.ts" }, false, undefined);
    const status = ledgerStatus(ledger);
    expect(status.changed).toEqual(["new.ts"]);
    expect(status.unverified).toEqual(["old.ts", "new.ts"]);
  });
});

describe("claims", () => {
  test.each(["Done — the bug is fixed.", "All tests pass.", "แก้แล้วครับ", "เสร็จแล้ว"])("%s claims done", (text) => {
    expect(detectClaims(text).done).toBe(true);
  });
  test("a plan is not a claim", () => {
    expect(detectClaims("Next I will edit the parser.")).toEqual({ done: false, ranCheck: false });
  });
  test.each(["I ran the tests and they pass.", "รัน test แล้ว"])("%s claims a check ran", (text) => {
    expect(detectClaims(text).ranCheck).toBe(true);
  });
});

describe("claimNudge", () => {
  const status = (over: Partial<ReturnType<typeof ledgerStatus>>) => ({ changed: [], checks: [], unverified: [], ...over });

  test("done with unverified changes names the files", () => {
    expect(claimNudge(status({ unverified: ["a.ts"] }), { done: true, ranCheck: false })).toContain("a.ts");
  });
  test("a claimed check with no check recorded is nudged", () => {
    expect(claimNudge(status({}), { done: false, ranCheck: true })).toContain("no check command ran");
  });
  test("done after a passing check is left alone", () => {
    expect(claimNudge(status({ checks: [{ kind: "check", command: "npm test", exitCode: 0 }] }), { done: true, ranCheck: true })).toBeUndefined();
  });
});

describe("receipt", () => {
  test("nothing happened, no receipt", () => {
    expect(receipt({ changed: [], checks: [], unverified: [] })).toBeUndefined();
  });
  test("lists changes, checks with exit codes, and unverified files", () => {
    const text = receipt({ changed: ["a.ts"], checks: [{ kind: "check", command: "npm test", exitCode: 1 }], unverified: ["a.ts"] });
    expect(text).toContain("`a.ts`");
    expect(text).toContain("`npm test` → exit 1");
    expect(text).toContain("Unverified: `a.ts`");
  });
});
