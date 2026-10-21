import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { secretPaths } from './secrets.ts';

// Where git looks for hooks in the repository holding `cwd`: core.hooksPath when set (`.husky`), otherwise
// .git/hooks. Undefined outside a repository.
export function hooksDir(cwd: string): string | undefined {
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--git-path', 'hooks'], { cwd, stdout: 'pipe', stderr: 'ignore' });
    const out = r.success ? r.stdout.toString().trim() : '';
    return out ? resolve(cwd, out) : undefined;
  } catch {
    return undefined; // no git, or no such directory
  }
}

// OS sandbox for bash, from @anthropic-ai/sandbox-runtime (Apache-2.0, used as a dependency):
// bubblewrap on Linux, sandbox-exec on macOS. Writes only inside the working directory and the temp dir,
// no reads of credential stores, network only to the allowed domains.
export type SandboxSetting = 'auto' | 'on' | 'off';
export const SANDBOX_SETTINGS: SandboxSetting[] = ['auto', 'on', 'off'];

export type Sandbox = {
  on: boolean;
  allowedDomains: string[];
  // Paths the sandbox mounts placeholders on while it is up; snapshots must not count them as changes.
  placeholders: string[];
  wrap(command: string): Promise<string>;
  close(): Promise<void>;
};

// Package registries only, so installs work; anything else is the user's call (--allow-domain or settings).
export const DEFAULT_DOMAINS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
];

// sandbox-runtime 0.0.81 always denies writes to these under the working directory, and on Linux puts a
// placeholder at each one that is missing until reset(). Keep in step when the pinned version changes.
const MANDATORY_DENY = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.vscode', '.idea', '.claude/commands', '.claude/agents'];

export const NO_SANDBOX: Sandbox = { on: false, allowedDomains: [], placeholders: [], wrap: async (c) => c, close: async () => {} };

export function sandboxConfig(cwd: string, allowedDomains: string[], cediaHome: string, hooks = hooksDir(cwd)) {
  return {
    network: { allowedDomains, deniedDomains: [] },
    filesystem: {
      denyRead: secretPaths(cediaHome),
      allowWrite: [cwd, tmpdir()],
      // Files that run code outside the sandbox later (git hooks and config) or set cedia's own rules.
      // Only paths that exist: on Linux a deny on a missing path puts a placeholder in the workspace while the
      // sandbox is up. The permission policy keeps edit and write out of these paths either way.
      denyWrite: [...new Set([join(cwd, '.git', 'hooks'), hooks ?? '', join(cwd, '.git', 'config'), join(cwd, '.cedia')])].filter((p) => p && existsSync(p)),
    },
  };
}

export async function openSandbox(
  cwd: string,
  setting: SandboxSetting,
  opts: { allowedDomains: string[]; cediaHome: string },
): Promise<{ sandbox: Sandbox; note?: string }> {
  if (setting === 'off') return { sandbox: NO_SANDBOX };
  const fail = (why: string) => {
    if (setting === 'on') throw new Error(`sandbox unavailable: ${why}`);
    return { sandbox: NO_SANDBOX, note: `cedia: sandbox unavailable (${why}); bash runs unsandboxed. Use --sandbox on to require it.` };
  };
  let manager: typeof import('@anthropic-ai/sandbox-runtime').SandboxManager;
  try {
    manager = (await import('@anthropic-ai/sandbox-runtime')).SandboxManager;
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!manager.isSupportedPlatform()) return fail(`${process.platform} is not supported`);
  const deps = manager.checkDependencies();
  if (deps.errors.length) return fail(deps.errors.join('; '));
  // A hooks directory that does not exist yet would be left writable, and a hook written there runs on the
  // user's next commit, outside the sandbox. Make it exist (empty, so git and the snapshots ignore it) to deny it.
  const hooks = hooksDir(cwd);
  for (const dir of [hooks, existsSync(join(cwd, '.git')) && statSync(join(cwd, '.git')).isDirectory() ? join(cwd, '.git', 'hooks') : undefined])
    if (dir && within(dir, cwd)) mkdirSync(dir, { recursive: true });
  const missing = MANDATORY_DENY.map((p) => join(cwd, p)).filter((p) => !existsSync(p));
  try {
    await manager.initialize(sandboxConfig(cwd, opts.allowedDomains, opts.cediaHome, hooks));
  } catch (e) {
    return fail((e as Error).message);
  }
  return {
    sandbox: {
      on: true,
      allowedDomains: opts.allowedDomains,
      placeholders: missing,
      wrap: (command) => manager.wrapWithSandbox(command),
      close: () => manager.reset(),
    },
  };
}

const within = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/');
};
