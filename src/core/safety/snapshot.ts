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
};

const SLOW_MS = 10_000;

// A working directory's snapshots: `<home>/snapshots/<project-slug>`, never recording cedia's home itself.
export const workspaceSnapshots = (cwd: string, home: string, exclude: string[] = []) => openSnapshots(cwd, join(home, 'snapshots', slugOf(cwd)), [home, ...exclude]);

// `exclude` lists paths never to record, such as cedia's own home when it sits inside the working directory.
export function openSnapshots(cwd: string, gitDir: string, exclude: string[] = []): Snapshots | undefined {
  const root = resolve(cwd);
  if (root === '/' || root === homedir()) return undefined; // too broad to snapshot on every write
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: gitDir,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: root,
    GIT_INDEX_FILE: join(gitDir, 'cedia-index'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const gitRaw = (args: string[]) => {
    const p = Bun.spawnSync(['git', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) throw new Error(`git ${args[0]}: ${p.stderr.toString().trim()}`);
    return p.stdout;
  };
  const git = (args: string[]) => gitRaw(args).toString();
  try {
    if (!existsSync(join(gitDir, 'HEAD'))) {
      mkdirSync(gitDir, { recursive: true });
      git(['init', '-q']);
    }
    const inside = [gitDir, ...exclude].map((p) => relative(root, resolve(p))).filter((r) => r && !r.startsWith('..') && !isAbsolute(r));
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(join(gitDir, 'info', 'exclude'), inside.map((r) => `/${r}\n`).join(''));
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
      const entries = new Map<string, { mode: string; blob: string }>();
      for (const line of git(['ls-tree', '-z', '--full-tree', tree, '--', ...files]).split('\0').filter(Boolean)) {
        const [meta, path] = [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)];
        const [mode, type, blob] = meta.split(' ');
        if (type === 'blob') entries.set(path, { mode: mode!, blob: blob! });
      }
      for (const f of files) {
        const abs = join(root, f);
        const rel = relative(root, abs);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
        const entry = entries.get(f);
        const present = (() => {
          try {
            return lstatSync(abs);
          } catch {
            return undefined;
          }
        })();
        if (present && !present.isDirectory()) rmSync(abs, { force: true });
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
  };
}
