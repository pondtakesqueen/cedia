// The sub-thread view: a thread's sub-threads one at a time, read from the thread store and the sub-thread's
// latest session log while they run (like OpenCode's child sessions: ← → between them, ↑ or Esc back to the
// thread). It only reads; Enter goes on with the one shown, as /thread <id> does.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Thread, ThreadState, TodoState } from '../../core/project/threads.ts';
import type { SessionEvent } from '../../core/types.ts';
import { toolName, toolTarget, type RowLine, type RowStyle } from './rows.ts';
import { sinceLabel } from './when.ts';

export type CallState = 'running' | 'ok' | 'err';
export type RecentCall = { tool: string; input: unknown; state: CallState };

// The newest calls a view shows, and how much of the end of a session log it reads to find them.
export const RECENT_CALLS = 6;
const TAIL_BYTES = 256 * 1024;

/** A thread's sub-threads, oldest first, so ← and → keep their order while they run. */
export function childThreads(threads: Thread[], parent: string): Thread[] {
  return threads
    .filter((t) => t.parent === parent)
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id));
}

/** The last calls in a session log, oldest first: a call with an intent and no result yet is still running. */
export function recentCalls(logPath: string | undefined, n = RECENT_CALLS): RecentCall[] {
  if (!logPath) return [];
  let text: string;
  try {
    const size = statSync(logPath).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    const fd = openSync(logPath, 'r');
    try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
    text = buf.toString('utf8');
    // A read that starts mid-file starts mid-line: that line is not whole.
    if (from > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return [];
  }
  const calls = new Map<string, RecentCall>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: SessionEvent;
    try { e = JSON.parse(line) as SessionEvent; } catch { continue; }
    if (e.kind === 'tool_intent') calls.set(e.callId, { tool: e.tool, input: e.input, state: 'running' });
    else if (e.kind === 'tool_result') {
      const c = calls.get(e.callId);
      if (c) c.state = e.output.isError ? 'err' : 'ok';
    }
  }
  return [...calls.values()].slice(-n);
}

const STATE: Record<ThreadState, [string, RowStyle]> = {
  queued: ['queued', 'muted'],
  working: ['working', 'accent'],
  asking: ['asking you', 'accent'],
  done: ['done', 'ok'],
  failed: ['failed', 'err'],
  stopped: ['stopped', 'muted'],
};
const TODO: Record<TodoState, [string, RowStyle]> = { done: ['✓', 'ok'], doing: ['◐', 'accent'], pending: ['○', 'faint'] };
const CALL: Record<CallState, [string, RowStyle]> = { running: ['●', 'accent'], ok: ['✓', 'ok'], err: ['✗', 'err'] };

const clip = (s: string, n: number) => (n <= 1 ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const line = (...spans: [string, RowStyle][]): RowLine => ({ spans: spans.map(([text, style]) => ({ text, style })) });

export type SubthreadPos = { at: number; of: number };

/** What the view shows of one sub-thread, at most `height` lines, the newest calls kept when it must cut. */
export function subthreadLines(t: Thread, pos: SubthreadPos, calls: RecentCall[], width: number, height: number, now = Date.now()): RowLine[] {
  const w = Math.max(20, width);
  const [stateText, stateStyle] = t.running && t.state === 'working' ? ['running', 'accent' as RowStyle] : STATE[t.state];
  const since = t.updatedAt ? sinceLabel(t.updatedAt, now) : '';
  const head: RowLine[] = [
    line([`Sub-thread ${pos.at + 1} of ${pos.of}`, 'muted'], ['  ', 'text'], [clip(t.title, w - 22), 'heading']),
    line(['  ', 'text'], [stateText, stateStyle], [`${since ? ` · ${since}` : ''} · ${t.id}${t.archived ? ' · archived' : ''}`, 'muted']),
  ];
  const task = oneLine(t.task);
  if (task && task !== t.title) head.push(line(['  ', 'text'], [clip(task, w - 2), 'muted']));
  const body: RowLine[][] = [];
  if (t.question && t.state === 'asking') body.push([line(['  ? ', 'accent'], [clip(oneLine(t.question.question), w - 4), 'text'])]);
  if (t.todo?.length) {
    body.push([line(['  Steps', 'name']), ...t.todo.map((i) => line(['  ', 'text'], [TODO[i.state][0], TODO[i.state][1]], [` ${clip(oneLine(i.text), w - 4)}`, i.state === 'done' ? 'muted' : 'text']))]);
  }
  if (calls.length) {
    body.push([line(['  Latest calls', 'name']), ...calls.map((c) => {
      const name = toolName(c.tool);
      return line(['  ', 'text'], [CALL[c.state][0], CALL[c.state][1]], [` ${name}`, 'name'], [`  ${clip(toolTarget(c.input), w - name.length - 6)}`, 'text']);
    })]);
  }
  if (t.result && (t.state === 'done' || t.state === 'failed')) {
    const result = t.result.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    body.push([line(['  Result', 'name']), ...result.slice(0, 4).map((l) => line(['  ', 'text'], [clip(l, w - 2), 'text'])), ...(result.length > 4 ? [line([`  … ${result.length - 4} more lines`, 'faint'])] : [])]);
  }
  if (!body.length) body.push([line(['  nothing yet', 'faint'])]);
  // Each part after a blank line; a short screen keeps the head and cuts each part's start, so the newest stays.
  let room = Math.max(1, height - head.length);
  const out: RowLine[] = [];
  for (const part of body.reverse()) {
    if (room <= 1) break;
    const take = part.slice(-(room - 1));
    out.unshift(line([' ', 'text']), ...take);
    room -= take.length + 1;
  }
  return [...head, ...out];
}

export const SUBTHREAD_HINT = '← → other sub-threads · ↑ or Esc back · Enter go on with this one';
