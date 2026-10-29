import { existsSync, readFileSync } from 'node:fs';
import { readEventsLenient } from '../session/usage.ts';
import { sessionPath } from '../session/log.ts';
import type { HeadlessResult, Question, ResultSubtype } from '../types.ts';
import type { Thread, ThreadState } from './threads.ts';

// What a thread did while its owner looked away: the runs since a moment, how each ended, the files they changed,
// the checks, the cost, and what waits for the owner now. Built from the thread file and the result each run wrote
// into its writer session's log, with no model call, so it is free, instant and says only what the logs prove.

export type RecapRun = { at: string; prompt: string; subtype?: ResultSubtype; result?: string; wallMs?: number; costUsd?: number };

export type AwayRecap = {
  thread: string;
  title: string;
  // The span it covers: from `since` to the thread's last event.
  since: string;
  until: string;
  state: ThreadState;
  running: boolean;
  runs: RecapRun[];
  costUsd: number;
  // Files the runs changed, and each check's last outcome, from the runs' evidence.
  changed: string[];
  checks: { command: string; passed: boolean }[];
  unverified: string[];
  subthreads: number;
  todo?: { done: number; total: number; doing?: string };
  // Messages other threads left since.
  messages: { from: string; at: string; text: string }[];
  question?: Question;
};

// Each run's result, from the writer sessions' logs: the last one written between its start and the next run's.
function runResults(t: Thread, cwd: string, home?: string): { at: string; result: HeadlessResult }[] {
  const out: { at: string; result: HeadlessResult }[] = [];
  for (const s of t.sessions) {
    if (s.role !== 'code' || s.rewound) continue;
    const path = s.path ?? sessionPath(cwd, s.sessionId, home);
    if (!existsSync(path)) continue;
    for (const e of readEventsLenient(readFileSync(path, 'utf8'))) if (e.kind === 'result') out.push({ at: e.at, result: e.result });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const firstLine = (s: string, n = 160) => {
  const line = s.trim().split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

export function awayRecap(t: Thread, since: Date, opts: { cwd: string; home?: string } = { cwd: process.cwd() }): AwayRecap {
  const from = since.toISOString();
  const results = runResults(t, opts.cwd, opts.home);
  const runs: RecapRun[] = [];
  const changed = new Set<string>();
  const checks = new Map<string, boolean>();
  const unverified = new Set<string>();
  let costUsd = 0;
  let subthreads = 0;
  t.runs.forEach((run, i) => {
    const next = t.runs[i + 1]?.at;
    const r = results.findLast((x) => x.at >= run.at && (!next || x.at < next));
    // A run counts when it started after the owner left, or was still going then: it ended (its result, else the
    // next run's start or the thread's last event) after that.
    const end = r?.at ?? next ?? t.updatedAt;
    if (run.at < from && end < from && !(t.running && !next)) return;
    runs.push({
      at: run.at,
      prompt: firstLine(run.prompt, 80),
      ...(r ? { subtype: r.result.subtype, result: firstLine(r.result.result), costUsd: r.result.costUsd, ...(r.result.timing ? { wallMs: r.result.timing.wallMs } : {}) } : {}),
    });
    if (!r) return;
    costUsd += r.result.costUsd;
    subthreads += r.result.subthreads ?? 0;
    for (const f of r.result.evidence?.changed ?? []) changed.add(f);
    for (const c of r.result.evidence?.checks ?? []) checks.set(c.command, c.exitCode === 0);
    for (const u of r.result.evidence?.unverified ?? []) unverified.add(u);
  });
  const todo = t.todo?.length ? { done: t.todo.filter((i) => i.state === 'done').length, total: t.todo.length, ...(t.todo.find((i) => i.state === 'doing') ? { doing: t.todo.find((i) => i.state === 'doing')!.text } : {}) } : undefined;
  return {
    thread: t.id,
    title: t.title,
    since: from,
    until: t.updatedAt,
    state: t.state,
    running: t.running,
    runs,
    costUsd,
    changed: [...changed].sort(),
    checks: [...checks].map(([command, passed]) => ({ command, passed })),
    unverified: [...unverified],
    subthreads,
    ...(todo ? { todo } : {}),
    messages: t.messages.filter((m) => m.from !== 'user' && m.at >= from).map((m) => ({ from: m.from, at: m.at, text: firstLine(m.text, 120) })),
    ...(t.question ? { question: { question: t.question.question, ...(t.question.options ? { options: t.question.options } : {}) } } : {}),
  };
}

// The default span: from the start of the thread's last run.
export const lastRunStart = (t: Thread): Date | undefined => (t.runs.at(-1) ? new Date(t.runs.at(-1)!.at) : undefined);

// `--since`: an ISO time, or a span back from now (90s, 30m, 2h, 1d).
export function recapSince(text: string, now = new Date()): Date {
  const span = /^(\d+)(s|m|h|d)$/.exec(text);
  if (span) return new Date(now.getTime() - Number(span[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as 's' | 'm' | 'h' | 'd']);
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) throw new Error(`--since ${text}: give a time (ISO 8601) or a span back from now (30m, 2h, 1d)`);
  return at;
}

export const spanText = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
};

const SHOWN_FILES = 6;

// The recap as a few lines. `heading` names the moment it is for ("while you were away").
export function formatRecap(r: AwayRecap, heading = 'recap'): string {
  const span = spanText(new Date(r.until).getTime() - new Date(r.since).getTime());
  const now = r.running ? 'still working' : r.state === 'asking' ? 'waiting for your answer' : r.state;
  const lines = [`${heading} (${span}): ${r.runs.length} run${r.runs.length === 1 ? '' : 's'}${r.costUsd ? `, $${r.costUsd.toFixed(2)}` : ''}, ${now}`];
  for (const run of r.runs) {
    const end = run.subtype ? `${run.subtype.replace(/_/g, ' ')}${run.wallMs !== undefined ? ` in ${spanText(run.wallMs)}` : ''}` : 'no result yet';
    lines.push(`  > ${run.prompt}  (${end})`);
    if (run.result) lines.push(`    ${run.result}`);
  }
  if (r.changed.length) {
    const more = r.changed.length - SHOWN_FILES;
    lines.push(`  changed ${r.changed.length} file${r.changed.length === 1 ? '' : 's'}: ${r.changed.slice(0, SHOWN_FILES).join(', ')}${more > 0 ? ` +${more} more` : ''}`);
  }
  if (r.checks.length) lines.push(`  checks: ${r.checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.command}`).join(' · ')}`);
  if (r.unverified.length) lines.push(`  unverified: ${r.unverified.join('; ')}`);
  if (r.subthreads) lines.push(`  ${r.subthreads} sub-thread${r.subthreads === 1 ? '' : 's'}`);
  if (r.todo) lines.push(`  todo ${r.todo.done}/${r.todo.total}${r.todo.doing ? `, now: ${r.todo.doing}` : ''}`);
  for (const m of r.messages) lines.push(`  message from ${m.from}: ${m.text}`);
  if (r.question) lines.push(`  asks: ${r.question.question}`, ...(r.question.options ?? []).map((o, i) => `    ${i + 1}. ${o}`));
  return lines.join('\n');
}
