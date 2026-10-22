import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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
// The worktree lives in the temp dir, in a directory only this user can enter; the child's sandbox lets bash
// write only inside its own worktree. What git ignores in the parent is brought in so the checks run there and
// never recorded or applied: directories (node_modules, build output) as links, which the child's sandbox keeps
// it from writing through, and small files (.env) as copies. Its snapshots run git with the worktree as the work
// tree but cedia's own git dir, and only once its directory is checked to be the one made, so neither a swapped
// directory nor what the child wrote in its .git file is followed.

export type Worktree = {
  // The worktree's root, and the directory the child works in: the parent's cwd at the same place in the repo.
  dir: string;
  cwd: string;
  snapshots: Snapshots & { drop(): void };
  // The tree the child started from.
  base: string;
  // Whether the directory is still the one made: not moved, and not replaced by a link to another.
  intact(): boolean;
  // Removes the directory and git's record of it.
  close(): void;
  // Keeps the directory, for the parent to read, and drops what recorded it.
  keep(): void;
};
export type Applied = { files: string[]; refused: string[]; conflicts: string[] };

// What git ignores and the child gets, at most; an ignored file larger than MAX_COPY is linked, not copied.
const MAX_LINKS = 500;
const MAX_COPY = 1024 * 1024;

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
  const id = `${projectSlug(repo).slice(-60)}-${name.replace(/[^\w.-]/g, '_')}`;
  const dir = join(root, id);
  rmSync(dir, { recursive: true, force: true });
  // What runs that crashed, or the week's sweep, left: git's records of worktrees that are gone, and the
  // snapshot indexes of worktrees no longer there.
  run(repo, ['worktree', 'prune']);
  parent.dropSiblings((sibling) => existsSync(join(root, sibling)));
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
    const snapshots = parent.at(at, id, links.map((l) => join(at, l)));
    if (!snapshots) throw new Error('cannot record the worktree');
    snapshots.restore(base);
    for (const l of links) {
      const from = join(cwd, l);
      const to = join(at, l);
      mkdirSync(dirname(to), { recursive: true });
      rmSync(to, { recursive: true, force: true });
      const st = lstatSync(from);
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else if (st.isFile() && st.size <= MAX_COPY) copyFileSync(from, to);
      else symlinkSync(from, to);
    }
    // The directories from the worktree's root down to the child's, as they were made.
    const chain = [dir, ...rel.split('/').filter(Boolean).map((_, i, parts) => join(dir, ...parts.slice(0, i + 1)))].map((p) => ({ p, st: lstatSync(p) }));
    const intact = () =>
      chain.every(({ p, st }) => {
        try {
          const now = lstatSync(p);
          return now.isDirectory() && !now.isSymbolicLink() && now.dev === st.dev && now.ino === st.ino;
        } catch {
          return false;
        }
      });
    const start = snapshots.take();
    if (!start) throw new Error('cannot record the worktree');
    return {
      dir,
      cwd: at,
      snapshots,
      base: start,
      intact,
      close: () => {
        snapshots.drop();
        close();
      },
      keep: () => snapshots.drop(),
    };
  } catch (e) {
    close();
    return { error: (e as Error).message };
  }
}

// The child's changes laid over the parent's working tree as it is now. Nothing is written when any file
// conflicts; a file `refuse` names (one the parent may not write) is left out and reported.
export function applyWorktree(wt: Worktree, parent: Snapshots, refuse: (file: string) => boolean): Applied {
  if (!wt.intact()) throw new Error('its worktree was moved or replaced while it ran, so nothing of it was read');
  const theirs = wt.snapshots.take();
  if (!theirs) throw new Error("cannot record the worktree's changes");
  if (theirs === wt.base) return { files: [], refused: [], conflicts: [] };
  const ours = parent.take();
  if (!ours) throw new Error("cannot record the working tree's state");
  const merged = parent.merge(wt.base, ours, theirs);
  if (merged.conflicts.length) return { files: [], refused: [], conflicts: merged.conflicts };
  const changed = parent.diff(ours, merged.tree);
  const refused = changed.filter(refuse);
  const wanted = changed.filter((f) => !refused.includes(f));
  // A nested repository the child made is not a file to write.
  const skipped = parent.restoreFiles(merged.tree, wanted);
  return { files: wanted.filter((f) => !skipped.includes(f)), refused: [...refused, ...skipped], conflicts: [] };
}
