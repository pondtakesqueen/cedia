import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { checkReadOnly } from '../tools/bash.ts';
import { effectOf, type ToolSpec } from '../tools/registry.ts';
import type { JsonObject } from '../types.ts';
import { simpleCommands } from './shell.ts';

// read-only: reads and read-only commands run; writes and other commands need an allow rule.
// workspace: writes inside the working directory and any command run, except the deny list.
export type PermissionMode = 'read-only' | 'workspace';
export const PERMISSION_MODES: PermissionMode[] = ['read-only', 'workspace'];

// Rules look like `bash`, `bash(bun test*)` or `edit(src/*)`. `*` matches anything. A bash pattern is
// matched against each simple command in the line, so `bun test && rm -rf x` needs both to be allowed.
export type Policy = { mode: PermissionMode; allow: string[]; deny: string[] };
export const READ_ONLY_POLICY: Policy = { mode: 'read-only', allow: [], deny: [] };

export type Decision = { decision: 'allow' | 'deny'; rule: string; reason?: string };

export function decide(policy: Policy, spec: ToolSpec, input: JsonObject, cwd: string): Decision {
  const command = spec.name === 'bash' ? String(input.command ?? '') : undefined;
  const commands = command !== undefined ? simpleCommands(command) : undefined;
  if (command !== undefined) {
    if (!commands) return deny('shell:unparsed', 'the command has unbalanced quotes');
    for (const argv of commands) {
      const hit = denyListed(argv, cwd);
      if (hit) return deny(`deny-list:${hit.name}`, hit.reason);
    }
  }
  const path = spec.pathOf?.(input);
  for (const rule of policy.deny) {
    if (matches(rule, spec.name, commands, path, cwd, 'any')) return deny(`deny:${rule}`, `matches the deny rule ${rule}`);
  }

  const effect = effectOf(spec, input);
  if (effect === 'read' || effect === 'network') return { decision: 'allow', rule: 'effect:read' };

  const allowRule = policy.allow.find((rule) => matches(rule, spec.name, commands, path, cwd, 'every'));
  if (effect === 'write_workspace' && path !== undefined && !insideWorkspace(path, cwd) && !allowRule)
    return deny('outside-workspace', `${path} is outside the working directory`);
  if (effect === 'write_workspace' && path !== undefined && protectedPath(path, cwd))
    return deny('protected-path', `${path} is git's or cedia's own config; ask the user to change it`);
  if (allowRule) return { decision: 'allow', rule: `allow:${allowRule}` };
  if (policy.mode === 'workspace') return { decision: 'allow', rule: 'mode:workspace' };
  return deny('mode:read-only', 'this session is read-only; writes and commands that may write need an allow rule');
}

const deny = (rule: string, reason: string): Decision => ({ decision: 'deny', rule, reason });

function matches(rule: string, tool: string, commands: string[][] | null | undefined, path: string | undefined, cwd: string, mode: 'any' | 'every'): boolean {
  const m = /^([\w-]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m || m[1] !== tool) return false;
  const pattern = m[2];
  if (pattern === undefined) return true;
  const re = glob(pattern);
  if (commands) {
    const line = (argv: string[]) => argv.join(' ');
    if (mode === 'any') return commands.some((argv) => re.test(line(argv)));
    // To allow, every simple command (substitutions included) must match or only read.
    return commands.length > 0 && commands.every((argv) => re.test(line(argv)) || checkReadOnly(line(argv)).ok);
  }
  if (path === undefined) return false;
  const full = resolve(cwd, path);
  return re.test(path) || re.test(full) || re.test(relative(cwd, full));
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

// .git (hooks and config run code later, outside any sandbox) and .cedia (cedia's rules and checks).
function protectedPath(path: string, cwd: string): boolean {
  const rel = relative(real(cwd), real(resolve(cwd, expandHome(path))));
  return /^(\.git|\.cedia)(\/|$)/.test(rel);
}

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

// The deny list holds what a weak model will not pause for on its own (pstack "Always pause").
// No allow rule or mode overrides it.
type Hit = { name: string; reason: string };

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
  if (name === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')) {
    const starts = args.slice(0, Math.max(0, args.findIndex((a) => a.startsWith('-')))).filter(Boolean);
    if ((starts.length ? starts : ['.']).some((p) => !resolvable(p) || !insideWorkspace(p, cwd)))
      return { name: 'rm-outside', reason: 'find -delete or -exec outside the working directory' };
  }
  const deploy = DEPLOYS[name];
  if (deploy?.(args)) return { name: 'deploy', reason: `${name} ${args.join(' ')} publishes or deploys; ask the user to run it` };
  return undefined;
}

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
  return undefined;
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
