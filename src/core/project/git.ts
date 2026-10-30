import { spawnSync } from 'node:child_process';

// Read-only looks at the user's repository, for the status line and `/diff`. They never take git's index lock
// (`--no-optional-locks`), so a status refresh never collides with the user's own git commands.

export type GitStatus = { branch: string; detached: boolean; dirty: number; ahead: number; behind: number };

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
};

const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z'];

// Undefined outside a git work tree.
export function gitStatus(cwd: string): GitStatus | undefined {
  const out = git(cwd, STATUS_ARGS);
  return out === undefined ? undefined : parseStatus(out);
}

function parseStatus(out: string): GitStatus {
  const s: GitStatus = { branch: '', detached: false, dirty: 0, ahead: 0, behind: 0 };
  let oid = '';
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (!r) continue;
    if (r.startsWith('# branch.oid ')) oid = r.slice('# branch.oid '.length);
    else if (r.startsWith('# branch.head ')) s.branch = r.slice('# branch.head '.length);
    else if (r.startsWith('# branch.ab ')) {
      const [a, b] = r.slice('# branch.ab '.length).split(' ');
      s.ahead = Number(a);
      s.behind = -Number(b);
    } else if (!r.startsWith('#')) {
      s.dirty++;
      // A rename or copy record is followed by its original path.
      if (r.startsWith('2 ')) i++;
    }
  }
  if (s.branch === '(detached)') {
    s.detached = true;
    s.branch = oid.slice(0, 7);
  }
  return s;
}

export const statusText = (s: GitStatus) =>
  `${s.detached ? 'detached ' : ''}${s.branch}${s.dirty ? ` +${s.dirty}` : ''}${s.ahead ? ` ↑${s.ahead}` : ''}${s.behind ? ` ↓${s.behind}` : ''}`;

// The working tree against HEAD: tracked changes as a patch, and untracked files by name. On a repository with no
// commit yet, everything is untracked.
export function workingDiff(cwd: string): { patch: string; untracked: string[] } | undefined {
  const head = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  const patch = head ? git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff']) : '';
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (patch === undefined || untracked === undefined) return undefined;
  return { patch, untracked: untracked.split('\0').filter(Boolean) };
}
