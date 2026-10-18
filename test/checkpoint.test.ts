import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkpointCount, createCheckpoint, initCheckpoint, undoCheckpoint } from "../src/checkpoint.ts";

describe("checkpoint", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("init creates checkpoint dir with initial commit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "a.txt"), "hello");
    const sessionId = "test-session";
    const dir = initCheckpoint(cwd, sessionId);
    expect(dir).toContain("checkpoints");
    expect(checkpointCount(dir)).toBeGreaterThanOrEqual(1);
  });

  test("createCheckpoint adds a commit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "a.txt"), "hello");
    const sessionId = "test-session-2";
    const dir = initCheckpoint(cwd, sessionId);
    const before = checkpointCount(dir);
    writeFileSync(join(cwd, "a.txt"), "world");
    const ok = createCheckpoint(dir, cwd, "update a.txt");
    expect(ok).toBe(true);
    expect(checkpointCount(dir)).toBeGreaterThan(before);
  });

  test("undo restores previous state", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cp-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "a.txt"), "hello");
    const sessionId = "test-session-3";
    const dir = initCheckpoint(cwd, sessionId);
    writeFileSync(join(cwd, "a.txt"), "world");
    createCheckpoint(dir, cwd, "update");
    const ok = undoCheckpoint(dir, cwd);
    expect(ok).toBe(true);
    const { readFileSync } = require("node:fs");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("hello");
  });
});