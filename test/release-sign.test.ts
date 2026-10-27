import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  sha256Hex,
  signArgs,
  verifyArgs,
  verifyManifest,
} from "../scripts/build-release.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cedia-release-sign-"));
}

function writeFixture(dir: string, body: string): { manifestPath: string; sha: string } {
  const bytes = new TextEncoder().encode(body);
  const sha = sha256Hex(bytes);
  writeFileSync(join(dir, "cedia"), bytes);
  const manifest = buildManifest([{ file: "cedia", target: "bun-linux-x64", sha256: sha, size: bytes.length }], "9.9.9");
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestPath, sha };
}

describe("signArgs", () => {
  test("returns gpg detached-sign argv", () => {
    expect(signArgs("dist/manifest.json", "dev@example.com")).toEqual([
      "gpg",
      "--armor",
      "--detach-sign",
      "-u",
      "dev@example.com",
      "-o",
      "dist/manifest.json.asc",
      "dist/manifest.json",
    ]);
  });
});

describe("verifyArgs", () => {
  test("returns gpg verify argv", () => {
    expect(verifyArgs("dist/manifest.json")).toEqual(["gpg", "--verify", "dist/manifest.json.asc", "dist/manifest.json"]);
  });
});

describe("verifyManifest", () => {
  test("ok when every file matches", () => {
    const dir = tmpDir();
    try {
      writeFixture(dir, "fake-binary-bytes");
      const result = verifyManifest(dir);
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on sha256 mismatch", () => {
    const dir = tmpDir();
    try {
      const { sha } = writeFixture(dir, "original");
      writeFileSync(join(dir, "cedia"), "tampered");
      const result = verifyManifest(dir);
      expect(result.ok).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("sha256 mismatch for cedia");
      expect(result.failures[0]).toContain(sha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on missing file", () => {
    const dir = tmpDir();
    try {
      writeFixture(dir, "original");
      rmSync(join(dir, "cedia"));
      const result = verifyManifest(dir);
      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(["missing cedia"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on missing manifest", () => {
    const dir = tmpDir();
    try {
      const result = verifyManifest(dir);
      expect(result.ok).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on invalid manifest json", () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "manifest.json"), "not-json{{{");
      const result = verifyManifest(dir);
      expect(result.ok).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on size mismatch with matching sha impossible, reports sha first", () => {
    const dir = tmpDir();
    try {
      writeFixture(dir, "sized");
      const manifestPath = join(dir, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.files[0].size += 100;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = verifyManifest(dir);
      expect(result.ok).toBe(false);
      expect(result.failures[0]).toContain("size mismatch for cedia");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
