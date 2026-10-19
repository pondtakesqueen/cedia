import { describe, expect, test } from "vitest";
import { approvalFor, loadHookRules, matchHooks, parseApprovalPolicy, parseSandboxMode } from "../src/hooks.ts";

describe("loadHookRules", () => {
  test("empty env gives no rules", () => {
    expect(loadHookRules({} as NodeJS.ProcessEnv)).toEqual([]);
  });
  test("parses event, pattern, command", () => {
    const rules = loadHookRules({ CEDIA_HOOKS: "pre_tool:bash:echo hi" } as NodeJS.ProcessEnv);
    expect(rules).toHaveLength(1);
    expect(rules[0].event).toBe("pre_tool");
    expect(rules[0].matcher.test("bash")).toBe(true);
  });
  test("skips bad lines and bad regex", () => {
    const rules = loadHookRules({ CEDIA_HOOKS: "junk\npre_tool:([:echo" } as NodeJS.ProcessEnv);
    expect(rules).toEqual([]);
  });
});

describe("matchHooks", () => {
  test("matches event and tool pattern", () => {
    const rules = loadHookRules({ CEDIA_HOOKS: "pre_tool:bash|write:echo x\npost_tool:bash:echo y" } as NodeJS.ProcessEnv);
    expect(matchHooks(rules, "pre_tool", "bash")).toHaveLength(1);
    expect(matchHooks(rules, "pre_tool", "read")).toHaveLength(0);
    expect(matchHooks(rules, "post_tool", "bash")).toHaveLength(1);
  });
});

describe("policies", () => {
  test("approval defaults to ask", () => {
    expect(parseApprovalPolicy(undefined)).toBe("ask");
    expect(parseApprovalPolicy("auto")).toBe("auto");
    expect(parseApprovalPolicy("deny")).toBe("deny");
    expect(parseApprovalPolicy("bogus")).toBe("ask");
  });
  test("sandbox defaults to off", () => {
    expect(parseSandboxMode(undefined)).toBe("off");
    expect(parseSandboxMode("read-only")).toBe("read-only");
    expect(parseSandboxMode("bogus")).toBe("off");
  });
  test("approvalFor maps policy and UI", () => {
    expect(approvalFor("deny", true)).toBe("block");
    expect(approvalFor("auto", false)).toBe("allow");
    expect(approvalFor("ask", true)).toBe("confirm");
    expect(approvalFor("ask", false)).toBe("block");
  });
});
