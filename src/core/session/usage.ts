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
};

export type SessionInput = { id: string; events: SessionEvent[] };

const modelOf = (ref: string): ModelSpec | undefined => {
  try {
    return resolveModel(ref);
  } catch {
    return undefined;
  }
};

const inputOf = (u: { uncached: number; cacheRead: number; cacheWrite: number }) => u.uncached + u.cacheRead + u.cacheWrite;

export function usageReport(sessions: SessionInput[], top = 5): UsageReport {
  const sent = new Map<string, number>();
  const largest: UsageReport['largest'] = [];
  const misses = new Map<string, { count: number; tokens: number }>();
  const tokens = { input: 0, cacheRead: 0, output: 0 };
  let requests = 0;
  let cost = 0;
  let keepaliveUsd = 0;
  let overPriceLine = 0;
  let maxEffort = 0;
  let handoffs = 0;
  let unpriced = 0;

  for (const s of sessions) {
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
    for (const e of s.events) {
      switch (e.kind) {
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
          sessionRequests++;
          for (const [k, v] of held) sent.set(k, (sent.get(k) ?? 0) + v);
          if (turnThinking) sent.set('thinking', (sent.get('thinking') ?? 0) + turnThinking);
          if ((effort ?? e.effort) === 'max') maxEffort++;
          model = modelOf(e.model) ?? model;
          break;
        case 'assistant': {
          const m = modelOf(e.model);
          tokens.input += inputOf(e.usage);
          tokens.cacheRead += e.usage.cacheRead;
          tokens.output += e.usage.output;
          // Priced at the time it ran: off-peak prices depend on it.
          if (m) cost += costUsd(m, e.usage, new Date(e.at));
          else unpriced++;
          if (m?.price.above && inputOf(e.usage) > m.price.above.tokens) overPriceLine++;
          for (const b of e.blocks) {
            if (b.type === 'text') hold('assistant text', b.text.length);
            else if (b.type === 'thinking') {
              const chars = b.text.length + (b.opaque?.length ?? 0);
              if (m?.caps.replayReasoning === 'same-turn') turnThinking += chars;
              else if (m?.caps.replayReasoning !== 'forbidden') hold('thinking', chars);
            }
            else {
              toolOf.set(b.callId ?? b.id, b.name);
              hold('tool calls', b.name.length + JSON.stringify(b.input).length);
            }
          }
          break;
        }
        case 'keepalive':
          if (e.usage && model) {
            const usd = costUsd(model, e.usage, new Date(e.at));
            cost += usd;
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
    tokens,
    sources: [...sent].map(([source, chars]) => ({ source, chars, share: total ? chars / total : 0 })).sort((a, b) => b.chars - a.chars),
    largest: largest.sort((a, b) => b.chars * b.resent - a.chars * a.resent).slice(0, top),
    misses: [...misses].map(([cause, m]) => ({ cause, ...m })).sort((a, b) => b.tokens - a.tokens),
    overPriceLine,
    maxEffort,
    handoffs,
    unpriced,
  };
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export function formatUsage(r: UsageReport): string {
  const lines = [
    `${r.sessions} session${r.sessions === 1 ? '' : 's'}, ${r.requests} requests, $${r.costUsd.toFixed(4)}${r.keepaliveUsd ? ` ($${r.keepaliveUsd.toFixed(4)} of it keeping caches warm)` : ''}`,
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
export const isUsageEvent = (e: SessionEvent): e is EventOf<'session' | 'user' | 'reminder' | 'effort' | 'request' | 'assistant' | 'keepalive' | 'tool_intent' | 'tool_result' | 'turn_end'> =>
  ['session', 'user', 'reminder', 'effort', 'request', 'assistant', 'keepalive', 'tool_intent', 'tool_result', 'turn_end'].includes(e.kind);

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
