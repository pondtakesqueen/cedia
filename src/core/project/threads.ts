import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inert } from '../trust/frame.ts';

// A project is a working directory; a thread is one line of work in it, made of one or more sessions. A session
// hands off to the next when its context grows long, and threads leave each other messages. Each thread is an
// append-only JSONL file, so two cedia processes can write to one without locking: a line is one small append.

export type ThreadState = 'working' | 'done' | 'failed' | 'stopped';
// rejected: the provider refused the last session's history, so the thread went on in a new one.
export type SessionWhy = 'start' | 'resume' | 'handoff' | 'quota' | 'rejected';

type ThreadBody =
  // parent: the thread that spawned this one as a sub-thread.
  | { kind: 'open'; title: string; task: string; parent?: string }
  | { kind: 'session'; sessionId: string; model: string; role: string; why: SessionWhy; path?: string }
  // Written when a session hands off: the note the next session starts from.
  | { kind: 'handoff'; sessionId: string; note: string }
  // from: another thread's id, or 'user'.
  | { kind: 'message'; id: string; from: string; text: string }
  // The messages a session was shown; they are in its log as a reminder.
  | { kind: 'delivered'; ids: string[]; sessionId: string }
  | { kind: 'state'; state: ThreadState; result?: string }
  // Hidden from lists, still readable. A sub-thread that finishes its task archives itself.
  | { kind: 'archived'; archived: boolean };
export type ThreadEvent = { at: string } & ThreadBody;

export type ThreadMessage = { id: string; from: string; text: string; at: string };
export type Thread = {
  id: string;
  title: string;
  task: string;
  state: ThreadState;
  parent?: string;
  archived: boolean;
  sessions: Extract<ThreadEvent, { kind: 'session' }>[];
  handoff?: { sessionId: string; note: string };
  result?: string;
  messages: ThreadMessage[];
  pending: ThreadMessage[];
  updatedAt: string;
};

// Long enough to carry a final answer to another thread; a thread that needs more reads the session log.
export const MAX_RESULT = 4000;

export function threadsDir(home: string, slug: string): string {
  return join(home, 'projects', slug, 'threads');
}

export const newThreadId = () => `t-${crypto.randomUUID().slice(0, 8)}`;

export const titleOf = (task: string) => {
  const line = task.trim().split('\n')[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
};

export class ThreadStore {
  constructor(readonly dir: string) {}

  private path(id: string) {
    if (!/^t-[0-9a-f]{8}$/.test(id)) throw new Error(`not a thread id: ${id}`);
    return join(this.dir, `${id}.jsonl`);
  }

  has(id: string): boolean {
    try {
      return existsSync(this.path(id));
    } catch {
      return false;
    }
  }

  append(id: string, body: ThreadBody, now = new Date()): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.path(id), JSON.stringify({ at: now.toISOString(), ...body }) + '\n');
  }

  open(task: string, opts: { parent?: string; now?: Date } = {}): string {
    const id = newThreadId();
    this.append(id, { kind: 'open', title: titleOf(task), task, ...(opts.parent ? { parent: opts.parent } : {}) }, opts.now);
    return id;
  }

  events(id: string): ThreadEvent[] {
    return readFileSync(this.path(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ThreadEvent);
  }

  read(id: string): Thread {
    return foldThread(id, this.events(id));
  }

  list(): Thread[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => this.read(f.slice(0, -'.jsonl'.length)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  send(to: string, from: string, text: string, now = new Date()): string {
    if (!this.has(to)) throw new Error(`no thread ${to} in this project`);
    const id = crypto.randomUUID();
    this.append(to, { kind: 'message', id, from, text }, now);
    return id;
  }
}

export function foldThread(id: string, events: ThreadEvent[]): Thread {
  const open = events.find((e) => e.kind === 'open');
  const t: Thread = {
    id,
    title: open?.title ?? id,
    task: open?.task ?? '',
    state: 'working',
    ...(open?.parent ? { parent: open.parent } : {}),
    archived: false,
    sessions: [],
    messages: [],
    pending: [],
    updatedAt: events.at(-1)?.at ?? '',
  };
  const delivered = new Set<string>();
  for (const e of events) {
    if (e.kind === 'session') t.sessions.push(e);
    else if (e.kind === 'handoff') t.handoff = { sessionId: e.sessionId, note: e.note };
    else if (e.kind === 'message') t.messages.push({ id: e.id, from: e.from, text: e.text, at: e.at });
    else if (e.kind === 'delivered') for (const m of e.ids) delivered.add(m);
    else if (e.kind === 'archived') t.archived = e.archived;
    else if (e.kind === 'state') {
      t.state = e.state;
      if (e.result !== undefined) t.result = e.result;
    }
  }
  t.pending = t.messages.filter((m) => !delivered.has(m.id));
  return t;
}

// How another thread's messages reach the model: one logged reminder per batch.
export function inboxReminder(messages: ThreadMessage[]): string {
  const body = messages.map((m) => `<message from="${m.from}" at="${m.at}">\n${inert(m.text)}\n</message>`).join('\n');
  return `New messages for this thread arrived while you worked. They are from the user or from other threads in this project: weigh them as information about the work, and reply with the message_thread tool when a thread asked you something.\n\n${body}`;
}

// One line per thread for the threads tool and `cedia threads`.
export function threadLine(t: Thread): string {
  const latest = (t.result ?? t.handoff?.note ?? '').trim().split('\n')[0] ?? '';
  return `${t.id}  ${t.state.padEnd(7)}  ${t.parent ? `(sub-thread of ${t.parent}) ` : ''}${t.archived ? '(archived) ' : ''}${t.title}${latest ? `\n    ${latest.length > 120 ? `${latest.slice(0, 117)}...` : latest}` : ''}`;
}
