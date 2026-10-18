import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { formatFindings, parseFindings, verifyFinding } from "../src/review.ts";

describe("parseFindings", () => {
  test("parses file evidence", () => {
    const text = "FINDING: missing null check\nEVIDENCE: file src/foo.ts:42";
    const findings = parseFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toBe("missing null check");
    expect(findings[0].type).toBe("file");
    expect(findings[0].evidence).toBe("src/foo.ts:42");
  });

  test("parses command evidence", () => {
    const text = "FINDING: test fails\nEVIDENCE: command npm test";
    const findings = parseFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("command");
    expect(findings[0].evidence).toBe("npm test");
  });

  test("parses multiple findings", () => {
    const text = "FINDING: issue A\nEVIDENCE: file a.ts:1\nFINDING: issue B\nEVIDENCE: command echo hi";
    const findings = parseFindings(text);
    expect(findings).toHaveLength(2);
  });
});

describe("verifyFinding", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("file evidence verified when line exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "rv-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.txt"), "line1\nline2\nline3");
    const f = verifyFinding({ description: "issue", evidence: "a.txt:2", type: "file" }, dir);
    expect(f.verified).toBe(true);
    expect(f.evidenceOutput).toBe("line2");
  });

  test("file evidence unverified when line out of range", () => {
    const dir = mkdtempSync(join(tmpdir(), "rv-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.txt"), "line1");
    const f = verifyFinding({ description: "issue", evidence: "a.txt:99", type: "file" }, dir);
    expect(f.verified).toBe(false);
  });

  test("command evidence verified when command fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "rv-"));
    dirs.push(dir);
    const f = verifyFinding({ description: "issue", evidence: "false", type: "command" }, dir);
    expect(f.verified).toBe(true);
  });

  test("command evidence unverified when command succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "rv-"));
    dirs.push(dir);
    const f = verifyFinding({ description: "issue", evidence: "true", type: "command" }, dir);
    expect(f.verified).toBe(false);
  });
});

describe("formatFindings", () => {
  test("no findings", () => {
    expect(formatFindings([])).toBe("No findings.");
  });
});