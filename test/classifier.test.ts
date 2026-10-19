import { describe, expect, test } from "vitest";
import { classifyCommand, parseBlock } from "../src/classifier.ts";

describe("parseBlock", () => {
  test("yes", () => expect(parseBlock("<block>yes</block>")).toBe(true));
  test("no", () => expect(parseBlock("<block>no</block>")).toBe(false));
  test("case insensitive", () => expect(parseBlock("<BLOCK>Yes</BLOCK>")).toBe(true));
  test("conflicting → null", () => expect(parseBlock("<block>yes</block> <block>no</block>")).toBeNull());
  test("unparseable → null", () => expect(parseBlock("maybe")).toBeNull());
});
describe("classifyCommand fail-closed", () => {
  test("blocks when no model exists", async () => {
    const registry = { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false as const }) } as any;
    const r = await classifyCommand("rm -rf /", registry, "clean up");
    expect(r.shouldBlock).toBe(true);
    expect(r.stage).toBe("unavailable");
  });
  test("blocks when auth missing on found model", async () => {
    const registry = {
      find: (provider: string) => (provider === "opencode-go" ? { provider, id: "x" } : undefined),
      getApiKeyAndHeaders: async () => ({ ok: false as const }),
    } as any;
    const r = await classifyCommand("rm -rf /tmp/x", registry, "");
    expect(r.shouldBlock).toBe(true);
  });
});
