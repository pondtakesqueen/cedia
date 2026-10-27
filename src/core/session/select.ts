// Session selection for read-only commands over past logs (`cedia usage`, `cedia permissions suggest`):
// explicit files, one thread (with its sub-threads), or the newest few sessions of this project.
// `usage` in cli.ts keeps its own copy with --since/--all; this stays the small shared shape.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ThreadStore, threadsDir } from '../project/threads.ts';
import { projectKey, sessionPath } from './log.ts';
import { readEventsLenient, dayOf, usageReport, type SessionInput } from './usage.ts';

export function selectSessions(opts: { cwd: string; home: string; thread?: string; last?: number; files?: string[] }): SessionInput[] {
  if (opts.files?.length) {
    return opts.files.filter((p) => existsSync(p)).map((path) => ({ id: basename(path).replace(/\.jsonl$/, ''), events: readEventsLenient(readFileSync(path, 'utf8')) }));
  }
  const slug = projectKey(opts.cwd);
  if (opts.thread) {
    const store = new ThreadStore(threadsDir(opts.home, slug));
    const all = store.list();
    const ids = [opts.thread];
    for (let i = 0; i < ids.length; i++) ids.push(...all.filter((t) => t.parent === ids[i]).map((t) => t.id));
    return ids.flatMap((id) => {
      try {
        return store.read(id).sessions.map((s) => ({ id: s.sessionId, events: readEventsLenient(readFileSync(s.path ?? sessionPath(opts.cwd, s.sessionId, opts.home), 'utf8')) }));
      } catch {
        return [];
      }
    });
  }
  const dir = join(opts.home, 'sessions', slug);
  if (!existsSync(dir)) return [];
  const found = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }));
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, opts.last ?? 20).map((f) => ({ id: basename(f.path).replace(/\.jsonl$/, ''), events: readEventsLenient(readFileSync(f.path, 'utf8')) }));
}

// Spend in this project today (local day), read from its session logs: the live half of the $20/day rule
// (SPEC Spend). Never throws: unreadable logs count as nothing spent.
export const DAILY_SPEND_WARN_USD = 20;

export function daySpendUsd(home: string, cwd: string, now = new Date()): number {
  try {
    const r = usageReport(selectSessions({ cwd, home, last: 50 }));
    return r.days.find((d) => d.day === dayOf(now))?.costUsd ?? 0;
  } catch {
    return 0;
  }
}
