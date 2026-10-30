import { isAbsolute, relative } from 'node:path';
import { redactSecrets } from '../safety/secrets.ts';
import { SessionLog, sessionExists } from '../session/log.ts';
import { sessionTexts } from '../tools/threads.ts';
import type { SessionEvent } from '../types.ts';
import type { Thread, ThreadState, ThreadStore } from './threads.ts';

// `cedia threads search`: which of the project's threads did something, found from their records and session
// logs with no model call. Every term must appear somewhere in a thread for it to match (case-insensitive; `a|b`
// in one term takes either). `editedPath` keeps the threads whose writer edited or wrote a file the glob matches,
// as the edit and write calls name it, relative to the run's directory: the files the model changed, not what is
// on disk now. A thread whose title or task holds the terms ranks first, then the one with the most hits, then the
// newest.

export type ThreadSearchHit = { where: string; text: string };
export type ThreadSearchMatch = { thread: string; title: string; state: ThreadState; updatedAt: string; hits: number; snippets: ThreadSearchHit[]; edited: string[] };
export type ThreadSearch = { terms: string[]; editedPath?: string; threads: ThreadSearchMatch[] };

const SNIPPETS = 3;
const AROUND = 80;

type Term = (s: string) => number;

function termOf(t: string): Term {
  const alts = t.toLowerCase().split('|').filter(Boolean);
  return (s) => {
    const low = s.toLowerCase();
    let at = -1;
    for (const a of alts) {
      const i = low.indexOf(a);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    return at;
  };
}

// The paths a session's edit and write calls named.
function editedPaths(events: SessionEvent[], cwd: string): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== 'assistant') continue;
    for (const b of e.blocks) {
      if (b.type !== 'tool_use' || !['edit', 'write', 'NotebookEdit'].includes(b.name)) continue;
      const input = b.input as { path?: unknown; notebook_path?: unknown };
      const p = typeof input.path === 'string' ? input.path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
      if (p) out.push(isAbsolute(p) ? relative(cwd, p) || p : p.replace(/^\.\//, ''));
    }
  }
  return out;
}

export function searchThreads(store: ThreadStore, opts: { terms: string[]; editedPath?: string; all?: boolean; limit?: number }): ThreadSearch {
  const terms = opts.terms.map((t) => t.trim()).filter(Boolean);
  const find = terms.map(termOf);
  const glob = opts.editedPath ? new Bun.Glob(opts.editedPath) : undefined;
  const matches: (ThreadSearchMatch & { head: boolean })[] = [];
  for (const t of store.list()) {
    if (!opts.all && (t.archived || t.side)) continue;
    const sessions = t.sessions.filter((s) => !s.rewound && s.path && sessionExists(s.path)).map((s) => ({ s, events: SessionLog.load(s.path!).events }));
    const cwd = t.runs.at(-1)?.cwd ?? '';
    const edited = [...new Set(sessions.flatMap(({ events }) => editedPaths(events, cwd)))];
    if (glob && !edited.some((p) => glob.match(p))) continue;
    const fields = threadFields(t);
    const texts = [...fields, ...sessions.flatMap(({ events }) => sessionTexts(events).map((x) => ({ where: x.label, text: x.text })))];
    if (!find.every((f) => texts.some((x) => f(x.text) >= 0))) continue;
    let hits = 0;
    const snippets: ThreadSearchHit[] = [];
    for (const x of texts) {
      const at = find.map((f) => f(x.text)).filter((i) => i >= 0);
      if (!at.length) continue;
      hits++;
      if (snippets.length >= SNIPPETS) continue;
      const first = Math.min(...at);
      const start = Math.max(0, first - AROUND);
      const piece = x.text.slice(start, first + AROUND).replace(/\s+/g, ' ').trim();
      snippets.push({ where: x.where, text: redactSecrets(`${start > 0 ? '...' : ''}${piece}${first + AROUND < x.text.length ? '...' : ''}`).text });
    }
    const head = find.length > 0 && fields.slice(0, 2).some((x) => find.some((f) => f(x.text) >= 0));
    matches.push({ thread: t.id, title: t.title, state: t.state, updatedAt: t.updatedAt, hits, snippets, edited: glob ? edited.filter((p) => glob.match(p)) : edited, head });
  }
  matches.sort((a, b) => Number(b.head) - Number(a.head) || b.hits - a.hits || b.updatedAt.localeCompare(a.updatedAt));
  return { terms, ...(opts.editedPath ? { editedPath: opts.editedPath } : {}), threads: matches.slice(0, opts.limit ?? 20).map(({ head: _, ...m }) => m) };
}

// What the thread's own record says, title and task first.
function threadFields(t: Thread): ThreadSearchHit[] {
  return [
    { where: 'title', text: t.title },
    { where: 'task', text: t.task },
    ...(t.result ? [{ where: 'result', text: t.result }] : []),
    ...(t.handoff ? [{ where: 'handoff', text: t.handoff.note }] : []),
    ...t.messages.filter((m) => !m.unsent).map((m) => ({ where: `message from ${m.from}`, text: m.text })),
  ];
}

export function searchText(r: ThreadSearch): string {
  if (!r.threads.length) return `no thread matches ${r.terms.map((t) => JSON.stringify(t)).join(' ')}${r.editedPath ? ` with an edit to ${r.editedPath}` : ''}`;
  return r.threads
    .map((m) => [`${m.thread}  ${m.state.padEnd(7)}  ${m.title}  (${m.hits} hit${m.hits === 1 ? '' : 's'})`, ...(r.editedPath ? [`    edited ${m.edited.join(', ')}`] : []), ...m.snippets.map((s) => `    [${s.where}] ${s.text}`)].join('\n'))
    .join('\n');
}
