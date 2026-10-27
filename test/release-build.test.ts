import { describe, expect, test } from "bun:test";
import { buildManifest, defaultTarget, sha256Hex } from "../scripts/build-release.ts";
import { selfSpawnArgs } from "../src/core/self.ts";

describe("selfSpawnArgs", () => {
  test("dev shim keeps [bun, cli.ts] prefix", () => {
    expect(selfSpawnArgs(["-p", "hi"], ["bun", "/repo/src/cli.ts", "-p"], "/bin/bun")).toEqual([
      "bun",
      "/repo/src/cli.ts",
      "-p",
      "hi",
    ]);
  });
  test("compiled binary re-spawns itself without a script", () => {
    expect(selfSpawnArgs(["-p", "x"], ["/dist/cedia", "-p"], "/dist/cedia")).toEqual(["/dist/cedia", "-p", "x"]);
  });
  test("bare argv (no argv[1]) uses execPath", () => {
    expect(selfSpawnArgs(["--version"], ["/dist/cedia"], "/dist/cedia")).toEqual(["/dist/cedia", "--version"]);
  });
});

describe("release build helpers", () => {
  test("defaultTarget maps node platform/arch to bun triples", () => {
    expect(defaultTarget("darwin", "arm64")).toBe("bun-darwin-arm64");
    expect(defaultTarget("linux", "x64")).toBe("bun-linux-x64");
    expect(defaultTarget("win32", "x64")).toBe("bun-windows-x64");
  });
  test("sha256Hex matches a known vector", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("buildManifest carries name, version and files", () => {
    const m = buildManifest([{ file: "cedia", target: "bun-darwin-arm64", sha256: "x", size: 1 }], "1.0.0");
    expect(m.name).toBe("cedia");
    expect(m.version).toBe("1.0.0");
    expect(m.files).toHaveLength(1);
    expect(typeof m.builtAt).toBe("string");
  });
});
