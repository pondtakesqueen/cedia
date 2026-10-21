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
  const [cmd, ...args] = argv;
  if (!cmd) return undefined;
  const name = cmd.split('/').pop()!;
  if (name === 'git') return gitHit(args);
  if (name === 'rm') return rmHit(args, cwd);
  if (name === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')) {
    const starts = args.slice(0, Math.max(0, args.findIndex((a) => a.startsWith('-')))).filter(Boolean);
    if ((starts.length ? starts : ['.']).some((p) => !resolvable(p) || !insideWorkspace(p, cwd)))
      return { name: 'rm-outside', reason: 'find -delete or -exec outside the working directory' };
  }
  return undefined;
}

const shortFlag = (args: string[], letter: string) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));

function gitHit(args: string[]): Hit | undefined {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]!) ? 2 : 1;
  const [subcommand, ...rest] = args.slice(i);
  if (subcommand === 'push') {
    const force = rest.some((a) => /^--(force|force-with-lease|mirror|delete|prune)(=|$)/.test(a)) || shortFlag(rest, 'f') || shortFlag(rest, 'd');
    const refspec = rest.some((a) => !a.startsWith('-') && /^[+:]/.test(a));
    if (force || refspec) return { name: 'force-push', reason: 'rewrites shared history' };
  }
  if (subcommand === 'reset' && rest.includes('--hard')) return { name: 'reset-hard', reason: 'throws away work' };
  if (subcommand === 'clean' && (rest.includes('--force') || shortFlag(rest, 'f')) && !rest.some((a) => a === '-n' || a === '--dry-run'))
    return { name: 'clean-force', reason: 'deletes untracked files' };
  return undefined;
}

function rmHit(args: string[], cwd: string): Hit | undefined {
  const dash = args.indexOf('--');
  const flags = (dash < 0 ? args : args.slice(0, dash)).filter((a) => a.startsWith('-'));
  const targets = dash < 0 ? args.filter((a) => !a.startsWith('-')) : [...args.slice(0, dash).filter((a) => !a.startsWith('-')), ...args.slice(dash + 1)];
  const recursive = flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f));
  if (!recursive) return undefined;
  if (!targets.length) return { name: 'rm-outside', reason: 'targets cannot be seen' };
  for (const t of targets) {
    if (!resolvable(t)) return { name: 'rm-outside', reason: `${t} cannot be resolved` };
    if (!insideWorkspace(t, cwd) || (!t.endsWith('*') && sameDir(t, cwd))) return { name: 'rm-outside', reason: `${t} reaches outside` };
  }
  return undefined;
}

const resolvable = (p: string) => !p.includes('$') && !/^~[^/]/.test(p);
