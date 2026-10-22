import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { projectSlug as slugOf } from '../session/log.ts';

// Shadow git: a separate git dir and index that record the working tree as trees, so cedia can name
// every file a call changed (bash included) and later undo a turn. It never touches the user's repo:
// GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE all point at cedia's copy, and user/system config is ignored.
export type Snapshots = {
  take(): string | undefined;
  diff(from: string, to: string): string[];
  patch(from: string, to: string, opts?: { context?: number }): string;
  restore(tree: string): void;
  restoreFiles(tree: string, files: string[]): void;
  // Three-way merge of trees, as git merges commits: the changes from `base` to `theirs` laid over `ours`. The
  // merged tree, or the files both sides changed in ways that do not combine.
  merge(base: string, ours: string, theirs: string): { tree: string; conflicts: string[] };
  // Another working directory recorded in the same store, with its own index: its trees can be merged with these
  // and restored here. `exclude` lists paths under it never to record.
  at(cwd: string, name: string, exclude?: string[]): (Snapshots & { drop(): void }) | undefined;
};

const SLOW_MS = 10_000;

// A working directory's snapshots: `<home>/snapshots/<project-slug>`, never recording cedia's home itself.
export const workspaceSnapshots = (cwd: string, home: string, exclude: string[] = []) => openSnapshots(cwd, join(home, 'snapshots', slugOf(cwd)), [home, ...exclude]);

// `exclude` lists paths never to record, such as cedia's own home when it sits inside the working directory.
export function openSnapshots(cwd: string, gitDir: string, exclude: string[] = [], name?: string): Snapshots | undefined {
  const root = resolve(cwd);
  if (root === '/' || root === homedir()) return undefined; // too broad to snapshot on every write
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: gitDir,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: root,
    GIT_INDEX_FILE: join(gitDir, name ? `cedia-index-${name}` : 'cedia-index'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    // Merges are commits of the store's own, never the user's: a fixed author, and no signing.
    GIT_AUTHOR_NAME: 'cedia',
    GIT_AUTHOR_EMAIL: 'cedia@localhost',
    GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'cedia',
    GIT_COMMITTER_EMAIL: 'cedia@localhost',
    GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
  };
  // A sibling's paths not to record go in its own excludes file, so the store's info/exclude stays this one's.
  const excludesFile = name ? join(gitDir, 'info', `exclude-${name}`) : undefined;
  const config = ['-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'commit.gpgSign=false', ...(excludesFile ? ['-c', `core.excludesFile=${excludesFile}`] : [])];
  const gitRaw = (args: string[]) => {
    // Another cedia process (a /diff beside a run) may hold the shadow index for a moment: wait for it rather
    // than lose a snapshot.
    for (let tries = 0; ; tries++) {
      const p = Bun.spawnSync(['git', ...config, ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
      if (p.exitCode === 0) return p.stdout;
      // merge-tree says "conflicts" with exit code 1, and still writes the merged tree.
      if (p.exitCode === 1 && args[0] === 'merge-tree') return p.stdout;
      const err = p.stderr.toString().trim();
      if (!err.includes('.lock') || tries >= 40) throw new Error(`git ${args[0]}: ${err}`);
      Bun.sleepSync(50);
    }
  };
  const git = (args: string[]) => gitRaw(args).toString();
  try {
    if (!existsSync(join(gitDir, 'HEAD'))) {
      mkdirSync(gitDir, { recursive: true });
      git(['init', '-q']);
    }
    const inside = [gitDir, ...exclude].map((p) => relative(root, resolve(p))).filter((r) => r && !r.startsWith('..') && !isAbsolute(r));
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(excludesFile ?? join(gitDir, 'info', 'exclude'), inside.map((r) => `/${r}\n`).join(''));
  } catch {
    return undefined;
  }
  let disabled = false;
  return {
    take() {
      if (disabled) return undefined;
      const start = Date.now();
      try {
        git(['add', '-A', '--ignore-errors', '.']);
        const tree = git(['write-tree']).trim();
        if (Date.now() - start > SLOW_MS) disabled = true; // a tree this large would slow every write
        return tree;
      } catch {
        return undefined;
      }
    },
    diff(from, to) {
      if (from === to) return [];
      return git(['diff-tree', '-r', '--name-only', '--no-renames', '-z', from, to]).split('\0').filter(Boolean);
    },
    // Unified diff, with no context lines unless asked (the slop guard reads it bare).
    patch(from, to, opts = {}) {
      if (from === to) return '';
      return git(['diff-tree', '-r', '-p', `-U${opts.context ?? 0}`, '--no-color', '--no-renames', '--no-ext-diff', from, to]);
    },
    // Puts the working tree back to `tree`: changed files restored, files added since removed.
    restore(tree) {
      const now = this.take();
      if (!now) throw new Error('cannot snapshot the current tree');
      const added = git(['diff-tree', '-r', '--name-only', '--no-renames', '--diff-filter=A', '-z', tree, now]).split('\0').filter(Boolean);
      git(['read-tree', tree]);
      git(['checkout-index', '-a', '-f']);
      for (const f of added) rmSync(join(root, f), { force: true });
    },
    // Puts only `files` back to how they are in `tree`, mode included: written from it, or removed where it has
    // none. Every other file stays as it is.
    restoreFiles(tree, files) {
      if (!files.length) return;
      const wanted = new Set(files);
      const entries = new Map<string, { mode: string; blob: string }>();
      // The whole tree, filtered here: a turn that changed thousands of files would not fit on a command line.
      for (const line of git(['ls-tree', '-r', '-z', '--full-tree', tree]).split('\0').filter(Boolean)) {
        const tab = line.indexOf('\t');
        const path = line.slice(tab + 1);
        const [mode, type, blob] = line.slice(0, tab).split(' ');
        if (type === 'blob' && wanted.has(path)) entries.set(path, { mode: mode!, blob: blob! });
      }
      const at = (p: string) => {
        try {
          return lstatSync(p);
        } catch {
          return undefined;
        }
      };
      // Checked for every file before any is written, so a refusal leaves the tree as it was.
      const todo = files.filter((f) => {
        const rel = relative(root, join(root, f));
        return rel && !rel.startsWith('..') && !isAbsolute(rel);
      });
      for (const f of todo) {
        const parts = f.split('/');
        // A parent that is now a symlink would take the write outside the working tree.
        if (parts.slice(0, -1).some((_, i) => at(join(root, ...parts.slice(0, i + 1)))?.isSymbolicLink())) throw new Error(`${f}: a parent directory is now a symlink`);
        if (at(join(root, f))?.isDirectory()) throw new Error(`${f}: a directory is there now`);
      }
      for (const f of todo) {
        const abs = join(root, f);
        const entry = entries.get(f);
        if (at(abs)) rmSync(abs, { force: true });
        if (!entry) continue;
        mkdirSync(dirname(abs), { recursive: true });
        const bytes = gitRaw(['cat-file', 'blob', entry.blob]);
        if (entry.mode === '120000') symlinkSync(bytes.toString(), abs);
        else {
          writeFileSync(abs, bytes);
          chmodSync(abs, entry.mode === '100755' ? 0o755 : 0o644);
        }
      }
    },
    merge(base, ours, theirs) {
      const commit = (tree: string) => git(['commit-tree', '-m', 'cedia', tree]).trim();
      const out = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${commit(base)}`, commit(ours), commit(theirs)]).split('\0');
      return { tree: out[0]!.trim(), conflicts: [...new Set(out.slice(1).filter(Boolean))] };
    },
    at(cwd, sibling, siblingExclude = []) {
      const id = sibling.replace(/[^\w.-]/g, '_');
      const s = openSnapshots(cwd, gitDir, siblingExclude, id);
      // Its index and excludes go with it; the trees it wrote stay, as the store's own do.
      return s && { ...s, drop: () => [`cedia-index-${id}`, join('info', `exclude-${id}`)].forEach((f) => rmSync(join(gitDir, f), { force: true })) };
    },
  };
}
