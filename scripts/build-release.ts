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

// Detached-signature sidecar for dist/manifest.json (manifest.json.asc).
// Console output only: an unsigned build is never a failure (dev machines
// have no key).
export type ManifestSignature = { signed: true; key: string } | { signed: false; reason: string };
export type ManifestVerification = { ok: boolean; failures: string[] };

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

// argv for `gpg --armor --detach-sign -u <key> -o <manifest>.asc <manifest>`.
export function signArgs(manifestPath: string, key: string): string[] {
  return ["gpg", "--armor", "--detach-sign", "-u", key, "-o", `${manifestPath}.asc`, manifestPath];
}

// argv for `gpg --verify <manifest>.asc <manifest>`.
export function verifyArgs(manifestPath: string): string[] {
  return ["gpg", "--verify", `${manifestPath}.asc`, manifestPath];
}

// Check every file listed in <dir>/manifest.json against its recorded sha256
// (plus size). Signature verification is left to the caller: it needs `gpg`
// on PATH and must stay offline-testable. Never throws for a bad manifest.
export function verifyManifest(dir: string): ManifestVerification {
  const failures: string[] = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, failures: [`missing ${manifestPath}`] };
  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  } catch (e) {
    return { ok: false, failures: [`invalid ${manifestPath}: ${(e as Error).message}`] };
  }
  for (const f of manifest.files ?? []) {
    const p = join(dir, f.file);
    if (!existsSync(p)) {
      failures.push(`missing ${f.file}`);
      continue;
    }
    const bytes = readFileSync(p);
    const actual = sha256Hex(bytes);
    if (actual !== f.sha256) failures.push(`sha256 mismatch for ${f.file}: expected ${f.sha256}, got ${actual}`);
    else if (bytes.length !== f.size) failures.push(`size mismatch for ${f.file}: expected ${f.size}, got ${bytes.length}`);
  }
  return { ok: failures.length === 0, failures };
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
    const argv = process.argv.slice(2);
    if (argv[0] === "verify") {
      let dir = join(import.meta.dir, "..", "dist");
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === "--dir" && argv[i + 1]) dir = argv[++i]!;
        else throw new Error(`unknown flag ${argv[i]}: expected --dir`);
      }
      const result = verifyManifest(dir);
      for (const f of result.failures) console.error(`cedia: ${f}`);
      let sigOk = true;
      const manifestPath = join(dir, "manifest.json");
      if (result.ok && existsSync(`${manifestPath}.asc`)) {
        if (!Bun.which("gpg")) {
          console.log("skipping signature check (gpg not found on PATH)");
        } else {
          const v = Bun.spawnSync(verifyArgs(manifestPath), { stdout: "pipe", stderr: "pipe" });
          if (v.exitCode !== 0) {
            sigOk = false;
            console.error(`cedia: signature verification failed:\n${v.stderr.toString()}`);
          } else {
            console.log(`signature ok (${manifestPath}.asc)`);
          }
        }
      }
      if (!result.ok || !sigOk) process.exit(1);
      console.log(`verified ${manifestPath}`);
      process.exit(0);
    }
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version?: string };
    if (pkg.version !== VERSION) throw new Error(`src/core/version.ts (${VERSION}) != package.json (${pkg.version}): bump them together`);
    const { targets, outfile, bytecode, minify } = parse(argv);
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
    const key = process.env.CEDIA_GPG_KEY;
    let sig: ManifestSignature;
    if (!key) {
      sig = { signed: false, reason: "CEDIA_GPG_KEY not set" };
    } else if (!Bun.which("gpg")) {
      sig = { signed: false, reason: "gpg not found on PATH" };
    } else {
      const s = Bun.spawnSync(signArgs(manifestPath, key), { stdout: "pipe", stderr: "pipe" });
      sig = s.exitCode === 0
        ? { signed: true, key }
        : { signed: false, reason: s.stderr.toString().trim() || `gpg exited with code ${s.exitCode}` };
    }
    // Unsigned is never a build failure: dev machines have no key.
    console.log(sig.signed ? `signed ${manifestPath}.asc (${sig.key})` : `unsigned (${sig.reason})`);
  } catch (e) {
    console.error(`cedia: ${(e as Error).message}`);
    process.exit(1);
  }
}
