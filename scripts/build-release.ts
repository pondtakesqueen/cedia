// `bun scripts/build-release.ts`: compile cedia to a Claude Code-style
// single-file executable (`bun build --compile`) plus a checksummed manifest.
//
// Dev keeps using `bin/cedia` (`exec bun src/cli.ts`); the release artifact is
// for zero-install distribution: one file with the Bun runtime inside, no Bun
// or Node needed at runtime. Usage:
//
//   bun scripts/build-release.ts [--target <bun-target>]... [--outfile <path>] [--no-bytecode] [--no-minify]
//
// Defaults: the current platform only, `dist/cedia`, bytecode + minify on.
// Cross-compile: `--target bun-linux-x64 --target bun-darwin-arm64 ...`; each
// target appends `-<target>` to the outfile name and all files land in
// `dist/manifest.json` as `ReleaseManifest`.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { VERSION } from "../src/core/version.ts";

export type ReleaseFile = { file: string; target: string; sha256: string; size: number };
export type ReleaseManifest = {
  name: "cedia";
  version: string;
  builtAt: string;
  bunVersion: string;
  files: ReleaseFile[];
};

// Node platform/arch to the `bun build --compile --target` triple.
export function defaultTarget(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "arm64" ? "arm64" : "x64";
  return `bun-${os}-${cpu}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function buildManifest(files: ReleaseFile[], version: string = VERSION): ReleaseManifest {
  return { name: "cedia", version, builtAt: new Date().toISOString(), bunVersion: Bun.version, files };
}

function parse(argv: string[]): { targets: string[]; outfile: string; bytecode: boolean; minify: boolean } {
  const targets: string[] = [];
  let outfile = join(import.meta.dir, "..", "dist", "cedia");
  let bytecode = true;
  let minify = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--target" && argv[i + 1]) targets.push(argv[++i]!);
    else if (a === "--outfile" && argv[i + 1]) outfile = argv[++i]!;
    else if (a === "--no-bytecode") bytecode = false;
    else if (a === "--no-minify") minify = false;
    else throw new Error(`unknown flag ${a}: expected --target, --outfile, --no-bytecode, --no-minify`);
  }
  return { targets: targets.length ? targets : [defaultTarget()], outfile, bytecode, minify };
}

async function buildOne(target: string, outfile: string, bytecode: boolean, minify: boolean): Promise<ReleaseFile> {
  const entry = join(import.meta.dir, "..", "src", "cli.ts");
  const args = ["build", entry, "--compile", `--target=${target}`, `--outfile=${outfile}`, "--format=esm"];
  // NOTE: do NOT mark react-devtools-core external. Ink imports it behind a
  // guarded dynamic import that stays lazy in the bundle (verified by probe),
  // but an --external of a missing package crashes a --bytecode binary at
  // startup: import.meta.resolve succeeds for externals, the guard passes, and
  // the require throws outside the try. Bundled, it only evaluates under DEV=true.
  if (bytecode) args.push("--bytecode");
  if (minify) args.push("--minify");
  args.push("--sourcemap=linked");
  const p = Bun.spawnSync(["bun", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString();
  const err = p.stderr.toString();
  if (p.exitCode !== 0) throw new Error(`bun ${args.join(" ")} failed:\n${out}\n${err}`);
  const bytes = readFileSync(outfile);
  const { size } = statSync(outfile);
  return { file: basename(outfile), target, sha256: sha256Hex(bytes), size };
}

if (import.meta.main) {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version?: string };
    if (pkg.version !== VERSION) throw new Error(`src/core/version.ts (${VERSION}) != package.json (${pkg.version}): bump them together`);
    const { targets, outfile, bytecode, minify } = parse(process.argv.slice(2));
    mkdirSync(dirname(outfile), { recursive: true });
    const files: ReleaseFile[] = [];
    for (const target of targets) {
      const out = targets.length > 1 ? `${outfile}-${target.replace(/^bun-/, "")}` : outfile;
      const exe = target.startsWith("bun-windows") && !out.endsWith(".exe") ? `${out}.exe` : out;
      files.push(await buildOne(target, exe, bytecode, minify));
      console.log(`built ${exe} (${target})`);
    }
    const manifest = buildManifest(files);
    const manifestPath = join(dirname(outfile), "manifest.json");
    const prev = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest) : null;
    const merged: ReleaseManifest = prev && prev.version === manifest.version
      ? { ...manifest, files: [...prev.files.filter((f) => !files.some((n) => n.target === f.target)), ...files] }
      : manifest;
    writeFileSync(manifestPath, JSON.stringify(merged, null, 2) + "\n");
    console.log(`wrote ${manifestPath}`);
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    process.exit(1);
  }
}
