import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { emptyReadState, isStale, recordRead, wasRead } from "../src/readstate.ts";

describe("readstate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("recorded file is wasRead", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-"));
    dirs.push(dir);
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    const state = emptyReadState();
    recordRead(state, file);
    expect(wasRead(state, file)).toBe(true);
  });

  test("unrecorded file is not wasRead", () => {
    const state = emptyReadState();
    expect(wasRead(state, "/nope.txt")).toBe(false);
  });

  test("stale detects mtime change", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-"));
    dirs.push(dir);
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    const state = emptyReadState();
    recordRead(state, file);
    expect(isStale(state, file)).toBe(false);
    // touch: rewrite changes mtime (may be same ms on fast FS; force a delay)
    const start = Date.now();
    while (Date.now() - start < 5) {}
    writeFileSync(file, "y");
    expect(isStale(state, file)).toBe(true);
  });

  test("missing file after read is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-"));
    dirs.push(dir);
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    const state = emptyReadState();
    recordRead(state, file);
    rmSync(file);
    expect(isStale(state, file)).toBe(true);
  });
});