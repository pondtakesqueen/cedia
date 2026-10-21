import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

  append<E extends NewEvent>(body: E): SessionEvent & E {
    const event = { id: crypto.randomUUID() as EventId, parentId: this.leaf?.id ?? null, at: new Date().toISOString(), ...body };
    if (this.path) appendFileSync(this.path, JSON.stringify(event) + '\n');
    this.events.push(event as SessionEvent);
    for (const l of this.listeners) l(event as SessionEvent);
    return event as SessionEvent & E;
  }
}

export function projectSlug(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'root';
}

export function sessionPath(cwd: string, id: string, home = process.env.CEDIA_HOME ?? join(homedir(), '.cedia')): string {
  return join(home, 'sessions', projectSlug(cwd), `${id}.jsonl`);
}

export function sessionExists(path: string): boolean {
  return existsSync(path);
}
