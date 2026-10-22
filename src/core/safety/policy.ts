import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { checkReadOnly, redirectsOutput } from '../tools/bash.ts';
import { effectOf, type ToolSpec } from '../tools/registry.ts';
import type { JsonObject } from '../types.ts';
import { REDACTED } from './secrets.ts';
import { simpleCommands } from './shell.ts';
import { hooksDir } from './sandbox.ts';

// read-only: reads and read-only commands run; writes and other commands need an allow rule.
// workspace: writes inside the working directory and any command run, except the deny list.
// cedia never stops to ask for permission: a denied call returns its reason to the model and the run goes on.
export type PermissionMode = 'read-only' | 'workspace';
export const PERMISSION_MODES: PermissionMode[] = ['read-only', 'workspace'];
// auto (the default setting): workspace when the OS sandbox is on, read-only when it is not. plan: read-only, and
// the writer is asked for a plan and the owner's go-ahead (ask_user) instead of the change; the change is a later
// run the owner lets write.
export type PermissionSetting = PermissionMode | 'auto' | 'plan';
export const PERMISSION_SETTINGS: PermissionSetting[] = ['auto', 'read-only', 'plan', 'workspace'];
// `cedia permissions --json`: the settings a client may offer for a run (`--permission`), and the one a run takes
// when it names none.
export type PermissionEntry = { mode: PermissionSetting; label: string; description: string };
export type PermissionList = { default: PermissionSetting; modes: PermissionEntry[] };
export const PERMISSION_ENTRIES: PermissionEntry[] = [
  { mode: 'auto', label: 'Auto', description: 'may edit when the OS sandbox is on, read only when it is off' },
  { mode: 'read-only', label: 'Read only', description: 'reads and read-only commands; no file writes' },
  { mode: 'plan', label: 'Plan first', description: 'read only, ending with a plan and the question whether to go ahead; the change is a later run' },
  { mode: 'workspace', label: 'May edit', description: 'writes inside the working directory and any command, except the deny list and guards' },
];
// What a run ran under, as its `run` thread event records it.
export type RunPermission = PermissionMode | 'plan';

// Built-in guards. The user (never a repo or the model) may lift one with `unlock`; nothing else lifts them.
export type Guard = 'force-push' | 'reset-hard' | 'clean-force' | 'drop-refs' | 'rm-outside' | 'deploy' | 'secret-path' | 'secret-redaction' | 'slop-check';
export const GUARDS: Guard[] = ['force-push', 'reset-hard', 'clean-force', 'drop-refs', 'rm-outside', 'deploy', 'secret-path', 'secret-redaction', 'slop-check'];

// Rules look like `bash`, `bash(bun test*)` or `edit(src/*)`. `*` matches anything. A bash pattern is
// matched against each simple command in the line, so `bun test && rm -rf x` needs both to be allowed.
// `secrets` are credential stores no tool may read or write (see secretPaths).
export type Policy = { mode: PermissionMode; plan?: boolean; allow: string[]; deny: string[]; unlock?: Guard[]; secrets?: string[] };
export const READ_ONLY_POLICY: Policy = { mode: 'read-only', allow: [], deny: [] };

export type Decision = { decision: 'allow' | 'deny'; rule: string; reason?: string };

export function decide(policy: Policy, spec: ToolSpec, input: JsonObject, cwd: string): Decision {
  const command = spec.name === 'bash' ? String(input.command ?? '') : undefined;
  const commands = command !== undefined ? simpleCommands(command) : undefined;
  const unlocked = (g: Guard) => policy.unlock?.includes(g) ?? false;
  const path = spec.pathOf?.(input);
  const effect = effectOf(spec, input);
  if (command !== undefined) {
    if (!commands) return deny('shell:unparsed', 'unbalanced quotes, an unclosed substitution or a heredoc it cannot read');
    for (const argv of commands) {
      const hit = denyListed(argv, cwd);
      if (hit && !unlocked(hit.name)) return deny(`deny-list:${hit.name}`, hit.reason);
    }
  }
  if (!unlocked('secret-path') && policy.secrets?.length) {
    const named = command !== undefined ? secretInCommand(command, commands!, policy.secrets, cwd) : path !== undefined ? secretUnder(path, policy.secrets, cwd) : undefined;
    if (named) return deny('deny-list:secret-path', `${named} holds credentials; cedia keeps it away from the model. Ask the user to run it`);
  }
  if (effect !== 'read' && JSON.stringify(input).includes(REDACTED))
    return deny('redacted-placeholder', `the input contains ${REDACTED}, which stands for a secret you were not shown; writing it would replace the real value. Leave that part as it is or ask the user`);
  for (const rule of policy.deny) {
    // edit and write change a file the same way, so a deny rule naming either covers both.
    const tool = spec.name === 'write' && /^edit\b/.test(rule.trim()) ? 'edit' : spec.name === 'edit' && /^write\b/.test(rule.trim()) ? 'write' : spec.name;
    if (matches(rule, tool, commands, path, cwd, 'any')) return deny(`deny:${rule}`, `matches the deny rule ${rule}`);
    if (command !== undefined && commands && writesDenied(rule, command, commands, cwd))
      return deny(`deny:${rule}`, `may write a path the deny rule ${rule} covers; that rule holds for commands too`);
  }

  if (effect === 'read' || effect === 'network') return { decision: 'allow', rule: 'effect:read' };

  const allowRule = policy.allow.find((rule) => matches(rule, spec.name, commands, path, cwd, 'every', command));
  if (effect === 'write_workspace' && path !== undefined && !insideWorkspace(path, cwd) && !allowRule)
    return deny('outside-workspace', `${path} is outside the working directory`);
  if (effect === 'write_workspace' && path !== undefined && protectedPath(path, cwd))
    return deny('protected-path', `${path} is git's or cedia's own config; ask the user to change it`);
  if (allowRule) return { decision: 'allow', rule: `allow:${allowRule}` };
  if (policy.mode === 'workspace') return { decision: 'allow', rule: 'mode:workspace' };
  // Say what made a command count as a write, so a model can split `a; b` into two read-only calls.
  const verdict = command !== undefined ? checkReadOnly(command) : undefined;
  const why = verdict && !verdict.ok ? verdict.reason : undefined;
  return deny('mode:read-only', `this session is read-only; writes and commands that may write need an allow rule${why ? ` (${why}; read-only commands may be run one at a time)` : ''}`);
}

const deny = (rule: string, reason: string): Decision => ({ decision: 'deny', rule, reason });

// Whether a call matches a rule the way a deny rule does: any simple command of a bash call, or the call's path.
export function ruleMatches(rule: string, spec: ToolSpec, input: JsonObject, cwd: string): boolean {
  const commands = spec.name === 'bash' ? simpleCommands(String(input.command ?? '')) : undefined;
  return matches(rule, spec.name, commands, spec.pathOf?.(input), cwd, 'any');
}

function matches(rule: string, tool: string, commands: string[][] | null | undefined, path: string | undefined, cwd: string, mode: 'any' | 'every', command?: string): boolean {
  const m = /^([\w-]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m || m[1] !== tool) return false;
  const pattern = m[2];
  if (pattern === undefined) return true;
  const re = glob(pattern);
  if (commands) {
    const line = (argv: string[]) => argv.join(' ');
    if (mode === 'any') return commands.some((argv) => re.test(line(argv)));
    // To allow, every simple command (substitutions included) must match or only read. The argv has lost its
    // redirections, so a command that writes through `>` is never covered: `echo x > f` would read as `echo x`.
    if (command !== undefined && redirectsOutput(command)) return false;
    return commands.length > 0 && commands.every((argv) => re.test(line(argv)) || checkReadOnly(line(argv)).ok);
  }
  if (path === undefined) return false;
  const full = resolve(cwd, path);
  return re.test(path) || re.test(full) || re.test(relative(cwd, full));
}

// An edit or write deny rule says a path must not change, so a command that may write and names such a path (a
// word, or the target of a redirection: `sed -i x`, `echo > x`, `cp y x`) is denied too. A read-only command
// may still name it.
function writesDenied(rule: string, command: string, commands: string[][], cwd: string): boolean {
  const m = /^(edit|write)\((.+)\)$/.exec(rule.trim());
  if (!m || checkReadOnly(command).ok) return false;
  const re = glob(m[2]!);
  const targets = [...command.matchAll(/>>?\|?\s*([^\s;|&<>()]+)/g)].map((t) => t[1]!.replace(/^['"]|['"]$/g, ''));
  const words = commands.flatMap((argv) => argv.slice(1)).filter((w) => !w.startsWith('-'));
  return [...words, ...targets].some((w) => {
    const full = resolve(cwd, expandHome(w));
    return re.test(w) || re.test(full) || re.test(relative(cwd, full));
  });
}

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

export function insideWorkspace(path: string, cwd: string): boolean {
  const root = real(cwd);
  const full = real(resolve(cwd, expandHome(path)));
  const rel = relative(root, full);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Resolves symlinks on the part of the path that exists, so a link out of the workspace is caught.
function real(path: string): string {
  let head = path;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return path;
    tail.unshift(head.slice(up.length).replace(/^\//, ''));
    head = up;
  }
  return resolve(realpathSync(head), ...tail);
}

// .git (hooks and config run code later, outside any sandbox), a hooks directory set by core.hooksPath (.husky)
// and .cedia (cedia's rules and checks).
export function protectedPath(path: string, cwd: string): boolean {
  const full = real(resolve(cwd, expandHome(path)));
  if (/^(\.git|\.cedia)(\/|$)/.test(relative(real(cwd), full))) return true;
  const hooks = hooksDir(cwd);
  return hooks !== undefined && within(full, real(hooks));
}

// The first secret store `path` falls under, if any. A store that holds the working directory is skipped, so
// a session run inside cedia's own home can still read its files.
function secretUnder(path: string, secrets: string[], cwd: string): string | undefined {
  const full = real(resolve(cwd, expandHome(path)));
  const root = real(cwd);
  return secrets.find((s) => {
    const store = real(s);
    return !within(root, store) && within(full, store);
  });
}

// A command names a store either as a word (`cat ~/.ssh/id_rsa`, `cp ../.aws/credentials x`) or anywhere in
// its text, which catches redirections (`< ~/.netrc`) and `$HOME/.ssh` that the word split drops or keeps literal.
function secretInCommand(command: string, commands: string[][], secrets: string[], cwd: string): string | undefined {
  const home = homedir();
  const text = command.replace(/\$\{?HOME\}?(?=\/|\b)/g, home).replace(/(^|[\s=<>'"(])~(?=\/)/g, `$1${home}`);
  for (const s of secrets) {
    if (within(real(cwd), real(s))) continue;
    const forms = [s, s.startsWith(home + '/') ? '~' + s.slice(home.length) : s];
    if (forms.some((f) => new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(text))) return s;
  }
  for (const argv of commands)
    for (const word of argv.slice(1)) {
      if (word.startsWith('-') || word.includes('$')) continue;
      const hit = secretUnder(word, secrets, cwd);
      if (hit) return hit;
    }
  return undefined;
}

const within = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

// The deny list holds what a weak model will not pause for on its own (pstack "Always pause").
// No allow rule or mode overrides it.
type Hit = { name: Guard; reason: string };

const DEPLOYS: Record<string, (args: string[]) => boolean> = {
  npm: (a) => sub(a) === 'publish',
  pnpm: (a) => sub(a) === 'publish',
  bun: (a) => sub(a) === 'publish',
  yarn: (a) => sub(a) === 'publish' || (sub(a) === 'npm' && a.includes('publish')),
  cargo: (a) => sub(a) === 'publish',
  gem: (a) => sub(a) === 'push',
  twine: (a) => sub(a) === 'upload',
  poetry: (a) => sub(a) === 'publish',
  uv: (a) => sub(a) === 'publish',
  docker: (a) => sub(a) === 'push',
  vercel: (a) => a.includes('--prod') || sub(a) === 'deploy' || sub(a) === undefined,
  netlify: (a) => sub(a) === 'deploy',
  fly: (a) => sub(a) === 'deploy',
  flyctl: (a) => sub(a) === 'deploy',
  firebase: (a) => sub(a) === 'deploy',
  wrangler: (a) => sub(a) === 'deploy' || sub(a) === 'publish',
  serverless: (a) => sub(a) === 'deploy' || sub(a) === 'remove',
  sls: (a) => sub(a) === 'deploy' || sub(a) === 'remove',
  cdk: (a) => sub(a) === 'deploy' || sub(a) === 'destroy',
  sam: (a) => sub(a) === 'deploy',
  gcloud: (a) => a.includes('deploy'),
  kubectl: (a) => ['apply', 'create', 'delete', 'replace', 'patch', 'rollout', 'scale', 'set', 'edit'].includes(sub(a) ?? ''),
  helm: (a) => ['install', 'upgrade', 'uninstall', 'rollback', 'delete'].includes(sub(a) ?? ''),
  terraform: (a) => ['apply', 'destroy', 'import'].includes(sub(a) ?? ''),
  tofu: (a) => ['apply', 'destroy', 'import'].includes(sub(a) ?? ''),
  pulumi: (a) => ['up', 'destroy', 'update'].includes(sub(a) ?? ''),
  gh: (a) => (a[0] === 'release' && ['create', 'delete', 'upload'].includes(a[1] ?? '')) || (a[0] === 'pr' && a[1] === 'merge') || (a[0] === 'repo' && a[1] === 'delete'),
};

const sub = (args: string[]) => args.find((a) => !a.startsWith('-'));
const shortFlag = (args: string[], letter: string) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));

export function denyListed(argv: string[], cwd: string): Hit | undefined {
  const [cmd, ...args] = argv;
  if (!cmd) return undefined;
  const name = cmd.split('/').pop()!;
  if (name === 'git') return gitHit(args);
  if (name === 'rm') return rmHit(args, cwd);
  if (name === 'security' && args.some((a) => KEYCHAIN_READS.includes(a)))
    return { name: 'secret-path', reason: `security ${args.join(' ')} reads the Keychain, where cedia's API keys live; ask the user to run it` };
  if (name === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')) {
    const starts = args.slice(0, Math.max(0, args.findIndex((a) => a.startsWith('-')))).filter(Boolean);
    if ((starts.length ? starts : ['.']).some((p) => !resolvable(p) || !insideWorkspace(p, cwd)))
      return { name: 'rm-outside', reason: 'find -delete or -exec outside the working directory' };
  }
  const deploy = DEPLOYS[name];
  if (deploy?.(args)) return { name: 'deploy', reason: `${name} ${args.join(' ')} publishes or deploys; ask the user to run it` };
  return undefined;
}

// macOS `security` subcommands that print a password or key, export them, or take commands from stdin (-i).
const KEYCHAIN_READS = ['find-generic-password', 'find-internet-password', 'find-key', 'dump-keychain', 'export', 'export-item', '-i', 'interactive'];

function gitHit(args: string[]): Hit | undefined {
  // Skip global options such as -C <dir> and -c k=v to reach the subcommand.
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]!) ? 2 : 1;
  const [subcommand, ...rest] = args.slice(i);
  if (subcommand === 'push') {
    const force = rest.some((a) => /^--(force|force-with-lease|mirror|delete|prune)(=|$)/.test(a)) || shortFlag(rest, 'f') || shortFlag(rest, 'd');
    const refspec = rest.some((a) => !a.startsWith('-') && /^[+:]/.test(a));
    if (force || refspec) return { name: 'force-push', reason: 'force-push, branch deletion and mirror push rewrite shared history; ask the user' };
  }
  if (subcommand === 'reset' && rest.includes('--hard'))
    return { name: 'reset-hard', reason: 'git reset --hard throws away work with no way back; use git stash or ask the user' };
  if (subcommand === 'clean' && (rest.includes('--force') || shortFlag(rest, 'f')) && !rest.some((a) => a === '-n' || a === '--dry-run'))
    return { name: 'clean-force', reason: 'git clean -f deletes untracked files with no way back; ask the user' };
  if (dropsRefs(subcommand, rest))
    return { name: 'drop-refs', reason: `git ${subcommand} ${rest.join(' ')} deletes commits or the record of them, which cedia's snapshots cannot bring back; ask the user` };
  return undefined;
}

// Commands that lose commits: the stash, a branch that is not merged, the reflog that finds lost commits, a
// ref, or history rewritten in place.
function dropsRefs(subcommand: string | undefined, rest: string[]): boolean {
  const verb = rest.find((a) => !a.startsWith('-'));
  if (subcommand === 'stash') return verb === 'drop' || verb === 'clear';
  if (subcommand === 'reflog') return verb === 'expire' || verb === 'delete';
  if (subcommand === 'update-ref') return rest.includes('--delete') || shortFlag(rest, 'd');
  if (subcommand === 'filter-branch' || subcommand === 'filter-repo') return true;
  if (subcommand === 'branch') {
    const del = rest.includes('--delete') || shortFlag(rest, 'd');
    const force = rest.includes('--force') || shortFlag(rest, 'f');
    return shortFlag(rest, 'D') || (del && force);
  }
  return false;
}

function rmHit(args: string[], cwd: string): Hit | undefined {
  const dash = args.indexOf('--');
  const flags = (dash < 0 ? args : args.slice(0, dash)).filter((a) => a.startsWith('-'));
  const targets = dash < 0 ? args.filter((a) => !a.startsWith('-')) : [...args.slice(0, dash).filter((a) => !a.startsWith('-')), ...args.slice(dash + 1)];
  const recursive = flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f));
  if (!recursive) return undefined;
  if (!targets.length) return { name: 'rm-outside', reason: 'rm -r with targets that cannot be seen (from xargs or a variable)' };
  for (const t of targets) {
    if (!resolvable(t)) return { name: 'rm-outside', reason: `rm -r ${t}: the target cannot be resolved before it runs` };
    if (!insideWorkspace(t, cwd) || sameDir(t, cwd)) return { name: 'rm-outside', reason: `rm -r ${t} reaches outside the working directory` };
  }
  return undefined;
}

// Variables and ~user cannot be resolved before the shell runs; `*` is fine because it stays under its parent.
const resolvable = (p: string) => !p.includes('$') && !/^~[^/]/.test(p);
// Removing the working directory itself is outside it; removing what is in it (`*`) is not.
const sameDir = (p: string, cwd: string) => !p.endsWith('*') && relative(real(cwd), real(resolve(cwd, expandHome(p)))) === '';
