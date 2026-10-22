import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { EventId, NewEvent, SessionEvent } from '../types.ts';

// Append-only JSONL. Each event is on disk before anything acts on it.
export class SessionLog {
  readonly events: SessionEvent[] = [];
  readonly listeners: ((e: SessionEvent) => void)[] = [];

  private constructor(
    readonly id: string,
    readonly path: string | null,
  ) {}

  static create(opts: { id?: string; path?: string | null } = {}): SessionLog {
    const id = opts.id ?? crypto.randomUUID();
    const path = opts.path === undefined ? null : opts.path;
    if (path) mkdirSync(dirname(path), { recursive: true });
    return new SessionLog(id, path);
  }

  static load(path: string): SessionLog {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const id = path.split('/').pop()!.replace(/\.jsonl$/, '');
    const log = new SessionLog(id, path);
    for (const line of lines) log.events.push(JSON.parse(line) as SessionEvent);
    return log;
  }

  get leaf(): SessionEvent | undefined {
    return this.events.at(-1);
  }

  // quiet: on disk but not sent to listeners, for an event a client already gets another way (the run's result).
  append<E extends NewEvent>(body: E, opts: { quiet?: boolean } = {}): SessionEvent & E {
    const event = { id: crypto.randomUUID() as EventId, parentId: this.leaf?.id ?? null, at: new Date().toISOString(), ...body };
    if (this.path) appendFileSync(this.path, JSON.stringify(event) + '\n');
    this.events.push(event as SessionEvent);
    if (!opts.quiet) for (const l of this.listeners) l(event as SessionEvent);
    return event as SessionEvent & E;
  }
}

export function projectSlug(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'root';
}

// The directory a project is known by. Every git worktree of a repository is the same project, keyed by the main
// worktree's root, so threads started in different worktrees list, message and recall one another. Outside git,
// or in a bare repository, the working directory itself.
export function projectRoot(cwd: string): string {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
  const common = r.status === 0 ? r.stdout.trim() : '';
  return common && basename(common) === '.git' ? dirname(common) : cwd;
}

// The slug threads and sessions are filed under. Snapshots stay per working directory: each worktree has its own
// tree to diff.
export const projectKey = (cwd: string) => projectSlug(projectRoot(cwd));

export function sessionPath(cwd: string, id: string, home = process.env.CEDIA_HOME ?? join(homedir(), '.cedia')): string {
  return join(home, 'sessions', projectKey(cwd), `${id}.jsonl`);
}

export function sessionExists(path: string): boolean {
  return existsSync(path);
}
