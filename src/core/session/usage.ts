import { attributeMisses } from '../context/cache.ts';
import { costUsd, resolveModel } from '../providers/catalog.ts';
import type { EventOf, ModelSpec, SessionEvent } from '../types.ts';

// Where a project's spend went, read from its session logs alone. Input is counted as characters times the
// requests that sent them again, the way the provider bills a growing context; a cached read is still a read.

export type UsageReport = {
  sessions: number;
  requests: number;
  costUsd: number;
  // Of that, what keeping a waiting session's cache warm cost (keepalive requests).
  keepaliveUsd: number;
  // And what summarizing sessions for the next one cost (server compaction).
  compactUsd: number;
  tokens: { input: number; cacheRead: number; output: number };
  // Characters sent, counting each time a request sent them again, by what they were: the system prompt and tool
  // definitions, user text, cedia's reminders, the model's own text, thinking and calls, and each tool's results.
  sources: { source: string; chars: number; share: number }[];
  // The tool results that cost most that way.
  largest: { session: string; callId: string; tool: string; chars: number; resent: number }[];
  misses: { cause: string; count: number; tokens: number }[];
  // Requests whose input passed the model's long-context price line, and requests at effort max.
  overPriceLine: number;
  maxEffort: number;
  // Sessions that ended by handing off to a new one.
  handoffs: number;
  // Replies from a model cedia's catalog does not know: no price, so not in costUsd.
  unpriced: number;
  // The same cost by local calendar day (oldest first), by model, by project and by thread (costliest first), for a
  // client's usage page. A session read without its project or thread counts under none there.
  days: { day: string; costUsd: number }[];
  models: { model: string; costUsd: number; requests: number }[];
  projects: { project: string; costUsd: number }[];
  threads: { thread: string; title: string; project?: string; costUsd: number }[];
};

// `project` is the project's key (its directory under sessions/), `thread` and `title` the thread the session is
// part of.
export type SessionInput = { id: string; events: SessionEvent[]; project?: string; thread?: string; title?: string };

export type UsageOptions = { top?: number; since?: Date };

// The local calendar day of an ISO time, as YYYY-MM-DD.
export const dayOf = (at: string | Date): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// `--since`: a day (YYYY-MM-DD, from its local midnight) or a number of days back (7d: from local midnight six days
// ago, so today counts as one).
export function sinceOf(text: string, now = new Date()): Date {
  const days = /^(\d+)d$/.exec(text);
  if (days) {
    const n = Number(days[1]);
    if (n < 1) throw new Error(`--since ${text}: count at least one day`);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1));
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!day) throw new Error(`--since ${text}: give a day (YYYY-MM-DD) or a number of days (7d)`);
  return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
}

const add = <K>(map: Map<K, number>, key: K, n: number) => map.set(key, (map.get(key) ?? 0) + n);

const modelOf = (ref: string): ModelSpec | undefined => {
  try {
    return resolveModel(ref);
  } catch {
    return undefined;
  }
};

const inputOf = (u: { uncached: number; cacheRead: number; cacheWrite: number }) => u.uncached + u.cacheRead + u.cacheWrite;

// Spend before `since` is left out of the cost and its breakdowns; the context it built still counts as sent.
export function usageReport(sessions: SessionInput[], opts: UsageOptions = {}): UsageReport {
  const top = opts.top ?? 5;
  const since = opts.since?.getTime() ?? -Infinity;
  const byDay = new Map<string, number>();
  const byModel = new Map<string, { costUsd: number; requests: number }>();
  const byProject = new Map<string, number>();
  const byThread = new Map<string, { title: string; project?: string; costUsd: number }>();
  const sent = new Map<string, number>();
  const largest: UsageReport['largest'] = [];
  const misses = new Map<string, { count: number; tokens: number }>();
  const tokens = { input: 0, cacheRead: 0, output: 0 };
  let requests = 0;
  let cost = 0;
  let keepaliveUsd = 0;
  let compactUsd = 0;
  let overPriceLine = 0;
  let maxEffort = 0;
  let handoffs = 0;
  let unpriced = 0;

  for (const s of sessions) {
    // Each billed amount, once, in every breakdown.
    const bill = (usd: number, at: string, model: string, request: boolean) => {
      cost += usd;
      add(byDay, dayOf(at), usd);
      const m = byModel.get(model) ?? { costUsd: 0, requests: 0 };
      byModel.set(model, { costUsd: m.costUsd + usd, requests: m.requests + (request ? 1 : 0) });
      if (s.project) add(byProject, s.project, usd);
      if (s.thread) {
        const t = byThread.get(s.thread) ?? { title: s.title ?? s.thread, ...(s.project ? { project: s.project } : {}), costUsd: 0 };
        byThread.set(s.thread, { ...t, costUsd: t.costUsd + usd });
      }
    };
    const billed = (at: string) => new Date(at).getTime() >= since;
    // What the session's context holds so far, by source, and the tool results in it with the request count
    // they arrived at.
    const held = new Map<string, number>();
    const results: { callId: string; tool: string; chars: number; at: number }[] = [];
    const toolOf = new Map<string, string>();
    let sessionRequests = 0;
    let model: ModelSpec | undefined;
    const hold = (source: string, chars: number) => held.set(source, (held.get(source) ?? 0) + chars);
    // Thinking goes back on every request ('required'), only until the next user text ('same-turn', DeepSeek's
    // tool loops), or never.
    let turnThinking = 0;
    // The level requests run at: the request's own, until an escalation changes it for the rest of the session.
    let effort: string | undefined;
    // A session that goes on from a summary (core/project/compact.ts) starts with copies of the turns it kept: sent
    // again as context, but billed in the session they came from.
    let copied = 0;
    for (const e of s.events) {
      const copy = copied > 0;
      if (copy) copied--;
      switch (e.kind) {
        case 'summary':
          hold('summary', e.block.text.length + e.block.opaque.length);
          copied = e.kept;
          break;
        case 'session':
          model = modelOf(e.model);
          hold('system prompt and tools', e.system.length + JSON.stringify(e.tools).length);
          break;
        case 'user':
          hold('user', e.text.length);
          turnThinking = 0;
          break;
        case 'reminder':
          hold('reminders', e.text.length);
          // On the wire a reminder sent as user text starts a new turn too, so same-turn thinking stops there.
          if (e.as === 'user') turnThinking = 0;
          break;
        case 'effort':
          effort = e.effort;
          break;
        case 'request':
          if (copy) break;
          sessionRequests++;
          for (const [k, v] of held) sent.set(k, (sent.get(k) ?? 0) + v);
          if (turnThinking) sent.set('thinking', (sent.get('thinking') ?? 0) + turnThinking);
          if ((effort ?? e.effort) === 'max') maxEffort++;
          model = modelOf(e.model) ?? model;
          break;
        case 'assistant': {
          const m = modelOf(e.model);
          if (!copy && billed(e.at)) {
            tokens.input += inputOf(e.usage);
            tokens.cacheRead += e.usage.cacheRead;
            tokens.output += e.usage.output;
            // Priced at the time it ran: off-peak prices depend on it.
            if (m) bill(costUsd(m, e.usage, new Date(e.at)), e.at, m.ref, true);
            else unpriced++;
            if (m?.price.above && inputOf(e.usage) > m.price.above.tokens) overPriceLine++;
          }
          for (const b of e.blocks) {
            if (b.type === 'text') hold('assistant text', b.text.length);
            else if (b.type === 'thinking') {
              const chars = b.text.length + (b.opaque?.length ?? 0);
              if (m?.caps.replayReasoning === 'same-turn') turnThinking += chars;
              else if (m?.caps.replayReasoning !== 'forbidden') hold('thinking', chars);
            } else if (b.type === 'tool_use') {
              toolOf.set(b.callId ?? b.id, b.name);
              hold('tool calls', b.name.length + JSON.stringify(b.input).length);
            }
          }
          break;
        }
        // A summary written for the next session (core/project/compact.ts): billed here, sent back only there.
        case 'compaction':
          if (!billed(e.at)) break;
          tokens.input += inputOf(e.usage);
          tokens.cacheRead += e.usage.cacheRead;
          tokens.output += e.usage.output;
          if (model) {
            const usd = costUsd(model, e.usage, new Date(e.at));
            bill(usd, e.at, model.ref, false);
            compactUsd += usd;
          }
          break;
        case 'keepalive':
          if (e.usage && model && billed(e.at)) {
            const usd = costUsd(model, e.usage, new Date(e.at));
            bill(usd, e.at, model.ref, false);
            keepaliveUsd += usd;
          }
          break;
        case 'tool_intent':
          toolOf.set(e.callId, e.tool);
          break;
        case 'tool_result': {
          const tool = toolOf.get(e.callId) ?? 'unknown';
          hold(`tool: ${tool}`, e.output.text.length);
          results.push({ callId: e.callId, tool, chars: e.output.text.length, at: sessionRequests });
          break;
        }
        case 'turn_end':
          if (e.reason === 'handoff') handoffs++;
          break;
      }
    }
    requests += sessionRequests;
    for (const r of results) largest.push({ session: s.id, callId: r.callId, tool: r.tool, chars: r.chars, resent: sessionRequests - r.at });
    if (model) {
      for (const row of attributeMisses(s.events, { minTokens: model.caps.cacheMinTokens, blockTokens: model.caps.cacheBlockTokens })) {
        if (!row.cause || row.cause === 'cold') continue;
        const m = misses.get(row.cause) ?? { count: 0, tokens: 0 };
        misses.set(row.cause, { count: m.count + 1, tokens: m.tokens + Math.max(0, row.reusable - row.cacheRead) });
      }
    }
  }

  const total = [...sent.values()].reduce((a, b) => a + b, 0);
  return {
    sessions: sessions.length,
    requests,
    costUsd: cost,
    keepaliveUsd,
    compactUsd,
    tokens,
    sources: [...sent].map(([source, chars]) => ({ source, chars, share: total ? chars / total : 0 })).sort((a, b) => b.chars - a.chars),
    largest: largest.sort((a, b) => b.chars * b.resent - a.chars * a.resent).slice(0, top),
    misses: [...misses].map(([cause, m]) => ({ cause, ...m })).sort((a, b) => b.tokens - a.tokens),
    overPriceLine,
    maxEffort,
    handoffs,
    unpriced,
    days: [...byDay].map(([day, costUsd]) => ({ day, costUsd })).sort((a, b) => a.day.localeCompare(b.day)),
    models: [...byModel].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.costUsd - a.costUsd),
    projects: [...byProject].map(([project, costUsd]) => ({ project, costUsd })).sort((a, b) => b.costUsd - a.costUsd),
    threads: [...byThread]
      .map(([thread, t]) => ({ thread, ...t }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, top),
  };
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

const extra = (r: UsageReport) => {
  const parts = [r.keepaliveUsd && `$${r.keepaliveUsd.toFixed(4)} keeping caches warm`, r.compactUsd && `$${r.compactUsd.toFixed(4)} summarizing for handoffs`].filter(Boolean);
  return parts.length ? ` (of it ${parts.join(', ')})` : '';
};

export function formatUsage(r: UsageReport): string {
  const lines = [
    `${r.sessions} session${r.sessions === 1 ? '' : 's'}, ${r.requests} requests, $${r.costUsd.toFixed(4)}${extra(r)}`,
    `tokens: ${k(r.tokens.input)} input (${pct(r.tokens.input ? r.tokens.cacheRead / r.tokens.input : 0)} from cache), ${k(r.tokens.output)} output`,
    'input by source (characters, each time a request sent them):',
    ...r.sources.map((s) => `  ${s.source.padEnd(24)} ${pct(s.share).padStart(4)}  ${k(s.chars)}`),
  ];
  if (r.largest.length) {
    lines.push('tool results that cost most (characters x requests that sent them):');
    for (const l of r.largest) lines.push(`  ${l.tool} ${l.callId} in ${l.session}: ${k(l.chars)} chars x ${l.resent}`);
  }
  lines.push(r.misses.length ? `cache misses: ${r.misses.map((m) => `${m.count} ${m.cause} (${k(m.tokens)} tokens)`).join(', ')}` : 'cache misses: none');
  const warn = [
    r.overPriceLine && `${r.overPriceLine} request${r.overPriceLine === 1 ? '' : 's'} past the model's long-context price line`,
    r.maxEffort && `${r.maxEffort} request${r.maxEffort === 1 ? '' : 's'} at effort max`,
    r.handoffs && `${r.handoffs} handoff${r.handoffs === 1 ? '' : 's'}`,
    r.unpriced && `${r.unpriced} repl${r.unpriced === 1 ? 'y' : 'ies'} from a model with no known price, left out of the cost`,
  ].filter(Boolean);
  if (warn.length) lines.push(`also: ${warn.join('; ')}`);
  return lines.join('\n');
}

// Only the events a report reads (an effort change included); the rest is dropped once read.
export const isUsageEvent = (e: SessionEvent): e is EventOf<'session' | 'summary' | 'user' | 'reminder' | 'effort' | 'request' | 'assistant' | 'compaction' | 'keepalive' | 'tool_intent' | 'tool_result' | 'turn_end'> =>
  ['session', 'summary', 'user', 'reminder', 'effort', 'request', 'assistant', 'compaction', 'keepalive', 'tool_intent', 'tool_result', 'turn_end'].includes(e.kind);

// Reads a log as far as its lines parse: a session still being written, or one a crash cut mid-line, still counts.
export function readEventsLenient(text: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      // a cut line
    }
  }
  return events;
}
