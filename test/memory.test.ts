import { describe, expect, test } from "vitest";
import { memoryDelete, memoryList, memoryRead, memorySearch, memoryWrite } from "../src/memory.ts";

// Override MEMORY_DIR by monkey-patching? Just test the functions directly.
describe("memory", () => {
  test("write and read", () => {
    memoryWrite("test-key", "hello world");
    expect(memoryRead("test-key")).toBe("hello world");
    memoryDelete("test-key");
  });

  test("read missing returns undefined", () => {
    expect(memoryRead("nonexistent-key-xyz")).toBeUndefined();
  });

  test("list includes written key", () => {
    memoryWrite("list-test", "content");
    expect(memoryList()).toContain("list-test");
    memoryDelete("list-test");
  });

  test("delete returns true for existing, false for missing", () => {
    memoryWrite("del-test", "content");
    expect(memoryDelete("del-test")).toBe(true);
    expect(memoryDelete("del-test")).toBe(false);
  });
  test("search finds matching content", () => {
    memoryWrite("search-test", "The quick brown fox jumps over the lazy dog");
    const results = memorySearch("brown fox");
    expect(results.some((r) => r.key === "search-test")).toBe(true);
    memoryDelete("search-test");
  });

  test("search returns empty for no match", () => {
    const results = memorySearch("zzzznonexistent");
    expect(results).toHaveLength(0);
  });
});