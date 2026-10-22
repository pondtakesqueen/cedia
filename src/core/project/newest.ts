import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { basename, join } from 'node:path';

// Newest edit wins: files that a three-way merge cannot combine sensibly, since a tool writes them whole from
// other files (lockfiles, generated code). When a work sub-thread and its parent both changed one, its merge back
// takes whichever side's file was written last, whole, instead of merging lines into a file no tool wrote or
// reporting a conflict. The idea is LayerFS's `.lww`; cedia takes the list from what the repo already says:
// the lockfiles of the common package managers by name, and what .gitattributes marks `linguist-generated` (the
// attribute GitHub reads to fold generated files in diffs) or `lww`.

export const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Cargo.lock',
  'go.sum',
  'go.work.sum',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'pdm.lock',
  'composer.lock',
  'flake.lock',
  'Package.resolved',
  'Podfile.lock',
  'pubspec.lock',
  'mix.lock',
  'gradle.lockfile',
  'packages.lock.json',
]);

const ATTRS = ['linguist-generated', 'lww'];

// Which of `files` (relative to `cwd`) are written whole by a tool.
export function newestWins(cwd: string, files: string[]): string[] {
  if (!files.length) return [];
  const marked = new Set<string>();
  const r = spawnSync('git', ['check-attr', '-z', '--stdin', ...ATTRS], { cwd, input: files.join('\0'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status === 0) {
    const out = r.stdout.split('\0');
    for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'set' || out[i + 2] === 'true') marked.add(out[i]!);
  }
  return files.filter((f) => LOCKFILES.has(basename(f)) || marked.has(f));
}

// When the file at `file` under `dir` was last written; never for one that is not there (a deletion has no time,
// so the side that still has the file wins).
export function writtenAt(dir: string, file: string): number {
  try {
    return lstatSync(join(dir, file)).mtimeMs;
  } catch {
    return -Infinity;
  }
}
