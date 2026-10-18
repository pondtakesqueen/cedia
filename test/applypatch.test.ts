import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyPatch } from "../src/applypatch.ts";

describe("applyPatch", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("updates a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@ \n-hello\n+hi\n*** End Patch";
    const result = applyPatch(patch, dir);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toContain("hi");
  });

  test("adds a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-"));
    dirs.push(dir);
    const patch = "*** Begin Patch\n*** Add File: b.txt\n+new content\n*** End Patch";
    const result = applyPatch(patch, dir);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toContain("new content");
  });

  test("deletes a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-"));
    dirs.push(dir);
    writeFileSync(join(dir, "c.txt"), "bye");
    const patch = "*** Begin Patch\n*** Delete File: c.txt\n*** End Patch";
    const result = applyPatch(patch, dir);
    expect(result.ok).toBe(true);
  });

  test("fails on missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-"));
    dirs.push(dir);
    const patch = "*** Begin Patch\n*** Update File: nope.txt\n@@ \n-old\n+new\n*** End Patch";
    const result = applyPatch(patch, dir);
    expect(result.ok).toBe(false);
  });
});