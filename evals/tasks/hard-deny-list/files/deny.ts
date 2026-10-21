import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

export type Hit = { name: 'force-push' | 'reset-hard' | 'clean-force' | 'rm-outside'; reason: string };

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

// True when `path` (relative to cwd, or absolute, or ~/...) is cwd itself or inside it.
export function insideWorkspace(path: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), resolve(cwd, expandHome(path)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Same directory as cwd, e.g. `.`, `./`, or cwd's absolute path.
export const sameDir = (path: string, cwd: string) => relative(resolve(cwd), resolve(cwd, expandHome(path))) === '';

// Looks at one simple command's argv (already split, quotes removed) and returns a Hit when it must be denied.
//
// git (argv[0] may be a path such as /usr/bin/git). Global options before the subcommand are skipped; -C, -c,
// --git-dir, --work-tree and --namespace take the next word as their value.
// - force-push: `push` with --force, --force-with-lease, --mirror, --delete or --prune (alone or with =value),
//   a short flag group containing f or d (-f, -fu, -df), or a refspec starting with + or : (+main, :old).
// - reset-hard: `reset` with --hard.
// - clean-force: `clean` with --force or a short flag group containing f, unless the word -n or --dry-run is
//   present (a group like -fn still counts as force).
//
// rm (argv[0] may be a path): only recursive removal is checked (--recursive or a short flag group containing r or R).
//   Words after `--` are targets even when they start with -. Before `--`, words starting with - are flags.
// - no targets at all (they come from xargs): rm-outside.
// - a target that cannot be resolved before it runs (contains $, or ~user): rm-outside.
// - a target outside cwd, or cwd itself (`.`, `..`, `/`, `~`): rm-outside. A glob such as `*` or `./*` stays
//   under cwd and is fine.
//
// find with -delete, -exec or -execdir: the start paths are the words before the first word starting with -
//   (none means `.`). Any start path that cannot be resolved or is outside cwd: rm-outside. cwd itself is fine.
//
// Anything else: undefined.
export function denyListed(argv: string[], cwd: string): Hit | undefined {
  throw new Error('not implemented');
}
