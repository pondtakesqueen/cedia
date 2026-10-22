import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Snapshots } from '../safety/snapshot.ts';
import { projectSlug } from '../session/log.ts';

// A work sub-thread's own copy of the working tree: a git worktree of the user's repository, detached at HEAD and
// filled with the parent's working tree as it is (uncommitted changes included), so the child sees what the
// parent sees and has git, while what it writes stays out of the parent's files until it is applied. Several
// can run at once. The changes come back as a three-way merge in cedia's snapshot store (base: the tree the
// child started from, ours: the parent's tree now, theirs: the child's), so two children that changed different
// parts of one file both land, and a change that does not combine is reported instead of written.
//
// The worktree lives in the temp dir (which the sandbox lets bash write, like the working directory), in a
// directory only this user can enter. What git ignores in the parent (node_modules, build output, .env) is
// linked, not copied, so the checks run there; the links are never recorded or applied. cedia never runs git
// inside the worktree, since what the child wrote there (its .git file included) is not to be trusted.

export type Worktree = {
  // The worktree's root, and the directory the child works in: the parent's cwd at the same place in the repo.
  dir: string;
  cwd: string;
  snapshots: Snapshots & { drop(): void };
  // The tree the child started from.
  base: string;
  // Removes the directory and git's record of it.
  close(): void;
};
export type Applied = { files: string[]; refused: string[]; conflicts: string[] };

// What git ignores and the child gets as links, at most.
const MAX_LINKS = 500;

const run = (cwd: string, args: string[]) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return r.status === 0 ? { ok: true as const, out: r.stdout } : { ok: false as const, err: (r.stderr || r.error?.message || '').trim() };
};

// The parent directory of every worktree: the user's own, closed to others. Worktrees left from runs a week ago
// or more (a crash, a failed child kept for a look) are removed as new ones are made.
export function worktreesRoot(root = join(tmpdir(), `cedia-worktrees-${process.getuid?.() ?? 'user'}`)): string | undefined {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const st = lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid !== undefined && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) return undefined;
    const weekAgo = Date.now() - 7 * 86_400_000;
    for (const old of readdirSync(root)) {
      const p = join(root, old);
      if (lstatSync(p).mtimeMs < weekAgo) rmSync(p, { recursive: true, force: true });
    }
    return root;
  } catch {
    return undefined;
  }
}

// `base` is the parent's tree now (a snapshot of `cwd`); `name` tells this worktree from the others.
export function openWorktree(cwd: string, parent: Snapshots, base: string, name: string, root = worktreesRoot()): Worktree | { error: string } {
  if (!root) return { error: 'no private directory for worktrees in the temp dir' };
  const top = run(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { error: 'not in a git repository' };
  const repo = top.out.trim();
  if (!run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) return { error: 'the repository has no commit yet' };
  const rel = relative(realpathSync(repo), realpathSync(cwd));
  const dir = join(root, `${projectSlug(repo).slice(-60)}-${name.replace(/[^\w.-]/g, '_')}`);
  rmSync(dir, { recursive: true, force: true });
  const added = run(repo, ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD']);
  if (!added.ok) return { error: `git worktree add failed: ${added.err.split('\n')[0]}` };
  const close = () => {
    rmSync(dir, { recursive: true, force: true });
    run(repo, ['worktree', 'prune']);
  };
  try {
    const at = join(dir, rel);
    // Ignored paths, as git lists them: a directory that is ignored whole is one entry ending in "/".
    const ignored = run(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
    const links = (ignored.ok ? ignored.out.split('\0').filter(Boolean) : []).map((p) => p.replace(/\/$/, '')).slice(0, MAX_LINKS);
    const snapshots = parent.at(at, name, links.map((l) => join(at, l)));
    if (!snapshots) throw new Error('cannot record the worktree');
    snapshots.restore(base);
    for (const l of links) {
      const to = join(at, l);
      mkdirSync(dirname(to), { recursive: true });
      rmSync(to, { recursive: true, force: true });
      symlinkSync(join(cwd, l), to);
    }
    const start = snapshots.take();
    if (!start) throw new Error('cannot record the worktree');
    return {
      dir,
      cwd: at,
      snapshots,
      base: start,
      close: () => {
        snapshots.drop();
        close();
      },
    };
  } catch (e) {
    close();
    return { error: (e as Error).message };
  }
}

// The child's changes laid over the parent's working tree as it is now. Nothing is written when any file
// conflicts; a file `refuse` names (one the parent may not write) is left out and reported.
export function applyWorktree(wt: Worktree, parent: Snapshots, refuse: (file: string) => boolean): Applied {
  const theirs = wt.snapshots.take();
  if (!theirs) throw new Error("cannot record the worktree's changes");
  if (theirs === wt.base) return { files: [], refused: [], conflicts: [] };
  const ours = parent.take();
  if (!ours) throw new Error("cannot record the working tree's state");
  const merged = parent.merge(wt.base, ours, theirs);
  if (merged.conflicts.length) return { files: [], refused: [], conflicts: merged.conflicts };
  const changed = parent.diff(ours, merged.tree);
  const refused = changed.filter(refuse);
  const files = changed.filter((f) => !refused.includes(f));
  parent.restoreFiles(merged.tree, files);
  return { files, refused, conflicts: [] };
}
