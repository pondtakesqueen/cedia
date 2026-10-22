import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inert } from '../trust/frame.ts';

// A project is a working directory; a thread is one line of work in it, made of one or more sessions. A session
// hands off to the next when its context grows long, and threads leave each other messages. Each thread is an
// append-only JSONL file, so two cedia processes can write to one without locking: a line is one small append.

// asking: the last run ended with a question for the owner (core/tools/ask.ts); the answer is the thread's next prompt.
export type ThreadState = 'working' | 'done' | 'failed' | 'stopped' | 'asking';
// rejected: the provider refused the last session's history, so the thread went on in a new one.
// rewind: a copy of a session as it was before a run, which the thread goes on from (core/project/rewind.ts).
export type SessionWhy = 'start' | 'resume' | 'handoff' | 'quota' | 'rejected' | 'rewind';

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
  // The user took back messages no session has seen yet (the desktop's message queue). A message that was
  // delivered stays delivered whatever the order of the two lines: the model saw it.
  | { kind: 'unsend'; ids: string[] }
  // The user's thumbs up or down on an answer: the session that gave it, if known. It picks eval cases and never
  // reaches a model.
  | { kind: 'rate'; rating: Rating; sessionId?: string; note?: string }
  // The question a session asked the owner, written just before the 'asking' state.
  | { kind: 'question'; sessionId: string; question: string; options?: string[] }
  | { kind: 'state'; state: ThreadState; result?: string }
  // A run of the thread that changed files: the shadow-git trees before its first write and after its last, across
  // every session it took (handoff, fallback, a review's fix), and the working directory they are of. What /undo
  // and /diff call a turn (core/project/undo.ts).
  | { kind: 'turn'; cwd: string; before: string; after: string; sessions: string[] }
  // A run of the thread starting: its prompt, the shadow-git tree of the working directory then, and the session
  // the conversation stood in, with how many of its events there were. What /rewind goes back to.
  | { kind: 'run'; id: string; prompt: string; cwd: string; tree?: string; from?: RunFrom }
  // The thread went back to just before run `run`: what happened from there to here is dropped from the fold
  // (core/project/rewind.ts), except what is not the conversation's (messages, ratings, archiving).
  | { kind: 'rewind'; run: string }
  // Hidden from lists, still readable. A sub-thread that finishes its task archives itself.
  | { kind: 'archived'; archived: boolean };
export type RunFrom = { sessionId: string; path: string; events: number; model: string };
// `run`: the run that wrote it, on what a run writes (core/project/rewind.ts).
export type ThreadEvent = { at: string; run?: string } & ThreadBody;

export type Rating = 'up' | 'down';
export const RATINGS: Rating[] = ['up', 'down'];

export type ThreadMessage = { id: string; from: string; text: string; at: string; unsent?: boolean };
export type ThreadRating = { rating: Rating; sessionId?: string; note?: string; at: string };
export type Thread = {
  id: string;
  title: string;
  task: string;
  state: ThreadState;
  parent?: string;
  archived: boolean;
  sessions: (Extract<ThreadEvent, { kind: 'session' }> & { rewound?: boolean })[];
  handoff?: { sessionId: string; note: string };
  result?: string;
  messages: ThreadMessage[];
  pending: ThreadMessage[];
  ratings: ThreadRating[];
  lastTurn?: { cwd: string; before: string; after: string; sessions: string[]; at: string };
  // Every run that changed files, oldest first (the last is what /undo takes back), and every run, as /rewind
  // lists them.
  // `runs` is how many runs had started when the turn was recorded: the run it belongs to, counted from 1.
  turns: (NonNullable<Thread['lastTurn']> & { runs: number })[];
  runs: Extract<ThreadEvent, { kind: 'run' }>[];
  // Sessions a rewind left behind: in `sessions`, and no longer part of the conversation.
  rewound: string[];
  // The last run has not ended yet (no state since it began): it is going on, or it was killed.
  running: boolean;
  // The open question while the thread is asking.
  question?: { sessionId: string; question: string; options?: string[]; at: string };
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

  append(id: string, body: ThreadBody & { run?: string }, now = new Date()): void {
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

  // Takes back the user's messages that no session has seen: the ids given, or all of them. A session may still
  // pick one up between the read here and the append; then the fold counts it as delivered.
  unsend(id: string, ids: string[] = [], now = new Date()): string[] {
    const t = this.read(id);
    const mine = t.pending.filter((m) => m.from === 'user');
    for (const m of ids) {
      if (mine.some((p) => p.id === m)) continue;
      const known = t.messages.find((x) => x.id === m);
      throw new Error(!known ? `no message ${m} in ${id}` : known.from !== 'user' ? `message ${m} is from ${known.from}, not the user` : known.unsent ? `message ${m} was already unsent` : `message ${m} was already delivered`);
    }
    const taken = ids.length ? ids : mine.map((m) => m.id);
    if (taken.length) this.append(id, { kind: 'unsend', ids: taken }, now);
    return taken;
  }

  rate(id: string, rating: Rating, opts: { sessionId?: string; note?: string; now?: Date } = {}): void {
    if (!RATINGS.includes(rating)) throw new Error(`a rating is ${RATINGS.join(' or ')}: ${rating}`);
    const t = this.read(id);
    if (opts.sessionId && !t.sessions.some((s) => s.sessionId === opts.sessionId)) throw new Error(`no session ${opts.sessionId} in ${id}`);
    // Unnamed, the answer is the thread's latest: its last writer session's.
    const sessionId = opts.sessionId ?? t.sessions.findLast((s) => s.role === 'code')?.sessionId;
    this.append(id, { kind: 'rate', rating, ...(sessionId ? { sessionId } : {}), ...(opts.note ? { note: opts.note } : {}) }, opts.now);
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
    ratings: [],
    turns: [],
    runs: [],
    rewound: [],
    running: false,
    updatedAt: events.at(-1)?.at ?? '',
  };
  const delivered = new Set<string>();
  const unsent = new Set<string>();
  const { live, dropped } = rewound(events);
  // A session resumed by a dropped run counts as dropped whole: the thread goes on in a copy of its start.
  t.rewound = [...new Set(dropped.flatMap((e) => (e.kind === 'session' ? [e.sessionId] : [])))];
  for (const e of live) {
    if (e.kind === 'session') t.sessions.push(e);
    else if (e.kind === 'handoff') t.handoff = { sessionId: e.sessionId, note: e.note };
    else if (e.kind === 'message') t.messages.push({ id: e.id, from: e.from, text: e.text, at: e.at });
    else if (e.kind === 'delivered') for (const m of e.ids) delivered.add(m);
    else if (e.kind === 'unsend') for (const m of e.ids) unsent.add(m);
    else if (e.kind === 'question') t.question = { sessionId: e.sessionId, question: e.question, ...(e.options ? { options: e.options } : {}), at: e.at };
    else if (e.kind === 'rate') t.ratings.push({ rating: e.rating, ...(e.sessionId ? { sessionId: e.sessionId } : {}), ...(e.note ? { note: e.note } : {}), at: e.at });
    else if (e.kind === 'archived') t.archived = e.archived;
    else if (e.kind === 'turn') t.turns.push({ ...(t.lastTurn = { cwd: e.cwd, before: e.before, after: e.after, sessions: e.sessions, at: e.at }), runs: t.runs.length });
    else if (e.kind === 'run') t.runs.push(e);
    else if (e.kind === 'state') {
      t.state = e.state;
      if (e.result !== undefined) t.result = e.result;
    }
  }
  // A session a rewind dropped is still listed (its log stays), marked, before the one the thread went on in.
  t.sessions = [...dropped.flatMap((e) => (e.kind === 'session' ? [{ ...e, rewound: true }] : [])), ...t.sessions].sort((a, b) => a.at.localeCompare(b.at));
  const lastRun = live.findLastIndex((e) => e.kind === 'run');
  t.running = lastRun >= 0 && !live.slice(lastRun).some((e) => e.kind === 'state');
  if (t.state !== 'asking') delete t.question;
  for (const m of t.messages) if (unsent.has(m.id) && !delivered.has(m.id)) m.unsent = true;
  t.pending = t.messages.filter((m) => !delivered.has(m.id) && !m.unsent);
  return t;
}

// What not to fold after each rewind: the events from the run it went back to up to the rewind itself, except
// messages, unsends, ratings and archiving, which are not the conversation's. A message delivered only to a
// session that was dropped is then waiting again, so the session the thread goes on in gets it. A rewind to a run
// that is not there (one an earlier rewind dropped) changes nothing.
// What a dropped run writes later (a run still going when the rewind came) is dropped too, by its `run` tag.
function rewound(events: ThreadEvent[]): { live: ThreadEvent[]; dropped: ThreadEvent[] } {
  let live: ThreadEvent[] = [];
  const dropped: ThreadEvent[] = [];
  const droppedRuns = new Set<string>();
  const keep = (x: ThreadEvent) => x.kind === 'message' || x.kind === 'unsend' || x.kind === 'rate' || x.kind === 'archived';
  for (const e of events) {
    if (e.kind !== 'rewind') {
      if (e.run && droppedRuns.has(e.run) && !keep(e)) dropped.push(e);
      else live.push(e);
      continue;
    }
    const at = live.findIndex((x) => x.kind === 'run' && x.id === e.run);
    if (at < 0) continue;
    for (const x of live.slice(at)) if (x.kind === 'run') droppedRuns.add(x.id);
    dropped.push(...live.slice(at).filter((x) => !keep(x)));
    live = [...live.slice(0, at), ...live.slice(at).filter(keep), e];
  }
  return { live, dropped };
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
