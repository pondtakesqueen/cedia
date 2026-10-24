import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome } from '../config.ts';
import { projectKey } from '../session/log.ts';

export type BgEvent =
  | { kind: 'start'; id: string; thread: string; pid: number; startedAt: string; logPath: string }
  | { kind: 'stop'; id: string; at: string };

export type BgSession = { id: string; thread: string; pid: number; startedAt: string; logPath: string; alive: boolean; stopped: boolean };

export const bgDir = (home = cediaHome()) => join(home, 'bg');
export const bgPath = (home: string, slug: string) => join(home, 'projects', slug, 'background.jsonl');
export const daemonPidPath = (home = cediaHome()) => join(home, 'daemon.pid');

export function readBgEvents(home: string, slug: string): BgEvent[] {
  const p = bgPath(home, slug);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').flatMap((l) => {
    try { const e = l.trim() ? JSON.parse(l) : null; if (e && (e.kind === 'start' || e.kind === 'stop')) return [e as BgEvent]; } catch {}
    return [];
  });
}

export function listBgSessions(home: string, slug: string): BgSession[] {
  const events = readBgEvents(home, slug);
  const map = new Map<string, BgSession>();
  for (const e of events) {
    if (e.kind === 'start') {
      map.set(e.id, { id: e.id, thread: e.thread, pid: e.pid, startedAt: e.startedAt, logPath: e.logPath, alive: isAlive(e.pid), stopped: false });
    } else if (e.kind === 'stop') {
      const s = map.get(e.id);
      if (s) { s.stopped = true; s.alive = false; }
    }
  }
  return [...map.values()];
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function recordStart(home: string, slug: string, rec: { id: string; thread: string; pid: number; logPath: string }) {
  mkdirSync(join(home, 'projects', slug), { recursive: true });
  const e: BgEvent = { kind: 'start', id: rec.id, thread: rec.thread, pid: rec.pid, startedAt: new Date().toISOString(), logPath: rec.logPath };
  appendFileSync(bgPath(home, slug), JSON.stringify(e) + '\n');
}

export function recordStop(home: string, slug: string, id: string) {
  const e: BgEvent = { kind: 'stop', id, at: new Date().toISOString() };
  appendFileSync(bgPath(home, slug), JSON.stringify(e) + '\n');
}

export function daemonStart(home = cediaHome()): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(daemonPidPath(home), String(process.pid));
}
export function daemonStop(home = cediaHome()): void {
  try { if (existsSync(daemonPidPath(home))) (require('node:fs') as any).unlinkSync(daemonPidPath(home)); } catch {}
}
export function daemonPid(home = cediaHome()): number | null {
  if (!existsSync(daemonPidPath(home))) return null;
  const n = Number(readFileSync(daemonPidPath(home), 'utf8').trim());
  return Number.isFinite(n) ? n : null;
}
