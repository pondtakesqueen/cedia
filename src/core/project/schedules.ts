import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Scheduled runs: a prompt for a thread of the project, at a time and maybe again every so often. cedia keeps the
// list and says what is due; it never runs anything at a time itself, since nothing of cedia's lives between runs.
// Whoever runs the project's threads (the desktop's daemon, or cron) asks `cedia schedules due`, marks each one it
// starts with `cedia schedules fire`, and runs `cedia -p <prompt> --thread <thread>`. A coordinator (core/profiles.ts)
// makes them with the schedule tool when the owner asks in the project chat, for its own thread: the daemon wakes
// it at the time. One append-only JSONL file per project, like a thread's.

export type ScheduleBody =
  // first: when it is first due. every: minutes between runs after that; a schedule without it runs once.
  | { kind: 'add'; id: string; prompt: string; thread: string; first: string; every?: number; by?: string }
  | { kind: 'enabled'; id: string; enabled: boolean }
  | { kind: 'cancel'; id: string }
  // A run of it started, for the time it was due.
  | { kind: 'fired'; id: string; due: string };
export type ScheduleEvent = { at: string } & ScheduleBody;

export type Schedule = {
  id: string;
  prompt: string;
  thread: string;
  by?: string;
  every?: number;
  enabled: boolean;
  // When it is next due; none once a one-off has run.
  next?: string;
  last?: string;
  createdAt: string;
};

// Runs no closer than this: a schedule is for waking a thread, not polling.
export const MIN_EVERY = 5;
const UNITS: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10080 };

export const schedulesPath = (home: string, slug: string) => join(home, 'projects', slug, 'schedules.jsonl');
export const newScheduleId = () => `s-${crypto.randomUUID().slice(0, 8)}`;

// "30m", "2h", "1d", "1w" as minutes.
export function minutesOf(text: string): number | undefined {
  const m = /^(\d+)\s*([mhdw])$/.exec(text.trim());
  return m ? Number(m[1]) * UNITS[m[2]!]! : undefined;
}

// When: an ISO time, or "in" a duration from now ("30m", "2h").
export function whenOf(text: string, now = new Date()): Date | undefined {
  const rel = minutesOf(text.replace(/^in\s+/, ''));
  if (rel !== undefined) return new Date(now.getTime() + rel * 60_000);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text.trim())) return undefined;
  const d = new Date(text.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export class ScheduleStore {
  constructor(readonly path: string) {}

  private append(body: ScheduleBody, now = new Date()) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify({ at: now.toISOString(), ...body }) + '\n');
  }

  events(): ScheduleEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ScheduleEvent);
  }

  list(): Schedule[] {
    return foldSchedules(this.events());
  }

  get(id: string): Schedule {
    const s = this.list().find((x) => x.id === id);
    if (!s) throw new Error(`no schedule ${id} in this project`);
    return s;
  }

  add(s: { prompt: string; thread: string; first: Date; every?: number; by?: string }, now = new Date()): Schedule {
    if (!s.prompt.trim()) throw new Error('a schedule needs a prompt');
    if (s.every !== undefined && (!Number.isInteger(s.every) || s.every < MIN_EVERY)) throw new Error(`a schedule repeats every ${MIN_EVERY} minutes at the most often`);
    const id = newScheduleId();
    this.append({ kind: 'add', id, prompt: s.prompt.trim(), thread: s.thread, first: s.first.toISOString(), ...(s.every ? { every: s.every } : {}), ...(s.by ? { by: s.by } : {}) }, now);
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean, now = new Date()) {
    this.get(id);
    this.append({ kind: 'enabled', id, enabled }, now);
  }

  cancel(id: string, now = new Date()) {
    this.get(id);
    this.append({ kind: 'cancel', id }, now);
  }

  // What is due at `now`: enabled, with its next time passed.
  due(now = new Date()): Schedule[] {
    return this.list().filter((s) => s.enabled && s.next !== undefined && s.next <= now.toISOString());
  }

  // Marks a run of it started for the time it was due. A repeating one is then due at the first time on its grid
  // after now, so a daemon that was asleep for a day runs a missed schedule once, not once for every time it missed.
  fire(id: string, now = new Date()): Schedule {
    const s = this.get(id);
    if (!s.next) throw new Error(`schedule ${id} is not due again`);
    this.append({ kind: 'fired', id, due: s.next }, now);
    return this.get(id);
  }
}

export function foldSchedules(events: ScheduleEvent[]): Schedule[] {
  const all = new Map<string, Schedule>();
  for (const e of events) {
    if (e.kind === 'add') {
      all.set(e.id, { id: e.id, prompt: e.prompt, thread: e.thread, ...(e.by ? { by: e.by } : {}), ...(e.every ? { every: e.every } : {}), enabled: true, next: e.first, createdAt: e.at });
      continue;
    }
    const s = all.get(e.id);
    if (!s) continue;
    if (e.kind === 'cancel') all.delete(e.id);
    else if (e.kind === 'enabled') s.enabled = e.enabled;
    else if (e.kind === 'fired') {
      s.last = e.at;
      if (!s.every) delete s.next;
      else {
        // The first time on its grid after the run started.
        const period = s.every * 60_000;
        const from = new Date(e.due).getTime();
        const steps = Math.max(1, Math.ceil((new Date(e.at).getTime() - from + 1) / period));
        s.next = new Date(from + steps * period).toISOString();
      }
    }
  }
  return [...all.values()];
}

export const scheduleLine = (s: Schedule) =>
  `${s.id}  ${s.enabled ? (s.next ? `next ${s.next}` : 'done') : 'paused'}${s.every ? `  every ${s.every}m` : ''}${s.last ? `  last ${s.last}` : ''}  thread ${s.thread}  ${s.prompt.split('\n')[0]!.slice(0, 80)}`;
