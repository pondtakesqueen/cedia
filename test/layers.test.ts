import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname;

// Layers that must stay UI-free. Clients may import them; they may not import clients.
const GUARDED = ["core", "protocol"];

type SourceFile = { path: string; source: string };

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return listTs(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

// Static `from` imports and re-exports, side-effect imports, and dynamic import().
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g;

function layerViolations(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!GUARDED.some((l) => f.path.startsWith(`${l}/`))) continue;
    for (const m of f.source.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? "";
      if (/(^|\/)clients(\/|$)/.test(spec)) out.push(`${f.path} imports ${spec}`);
    }
  }
  return out;
}

describe("layer rule", () => {
  test("detects a core file importing a client", () => {
    const files = [
      { path: "core/loop.ts", source: `import { render } from "../clients/tui/render.ts";` },
      { path: "protocol/x.ts", source: `const m = await import("../clients/headless");` },
      { path: "core/side.ts", source: `import "../clients/setup.ts";` },
      { path: "clients/tui/app.ts", source: `import { run } from "../../core/index.ts";` },
      { path: "core/ok.ts", source: `import { codec } from "../protocol/index.ts";` },
    ];
    expect(layerViolations(files)).toEqual([
      "core/loop.ts imports ../clients/tui/render.ts",
      "protocol/x.ts imports ../clients/headless",
      "core/side.ts imports ../clients/setup.ts",
    ]);
  });

  test("src/core and src/protocol never import from src/clients", () => {
    const files = listTs(SRC).map((p) => ({ path: relative(SRC, p), source: readFileSync(p, "utf8") }));
    expect(files.some((f) => f.path.startsWith("core/"))).toBe(true);
    expect(layerViolations(files)).toEqual([]);
  });
});
