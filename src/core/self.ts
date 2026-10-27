// How cedia re-spawns itself for detached work (`--bg`, `respawn`).
//
// Under `bin/cedia` the process is `bun <repo>/src/cli.ts ...`, so the child
// needs `[bun, cli.ts, ...args]`. A `bun build --compile` single-file binary
// is its own runtime: `process.argv` is `[binary, ...args]` with no script in
// argv[1], so the child is `[execPath, ...args]`. This helper picks between
// the two from the current argv, with injectable inputs so tests stay offline.
export function selfSpawnArgs(extra: string[], argv: string[] = process.argv, execPath: string = process.execPath): string[] {
  const script = argv[1] ?? "";
  // The dev shim always execs a TypeScript entry (src/cli.ts). Anything else
  // (a user flag like `-p`, a subcommand like `respawn`, or nothing) means the
  // process is already the compiled binary.
  const scripted = script.endsWith(".ts") || script.endsWith(".js") || script.includes("src/cli");
  if (scripted && argv[0] && script) return [argv[0], script, ...extra];
  return [execPath, ...extra];
}
