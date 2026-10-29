import { sessionPath } from '../session/log.ts';
import type { Thread } from '../project/threads.ts';
import { resolveModel } from '../providers/catalog.ts';
import type { ModelSpec, SessionEvent } from '../types.ts';

// What fills one session's context now: what the next request would send, split by what it is. `cedia usage`
// counts what was sent again over many requests (the bill); this is one snapshot (the window). Read from the
// session log alone, so it works on a live session, an old one, or a log copied from another machine.

// fixed: sent on every request of the session whatever the conversation does (the system prompt, the tool
// definitions, the first turn's preamble). conversation: what the session added since.
export type ContextPart = { part: string; group: 'fixed' | 'conversation'; chars: number; tokens: number; share: number; count?: number };

export type ContextBreakdown = {
  sessionId?: string;
  model: string;
  // The model's window, and where the session hands off when that is known.
  window?: number;
  handoffAt?: number;
  // Tokens in context now. measured: the last reply's usage (its request plus the reply) plus chars/4 of what came
  // after it, the way the loop estimates; otherwise chars/4 of everything, which undercounts JSON tool schemas.
  tokens: number;
  measured: boolean;
  // Each part's tokens are its share of `tokens` by characters, largest first.
  parts: ContextPart[];
  // The tool results that take most of it.
  largest: { callId: string; tool: string; tokens: number }[];
};

// The framed blocks of the first turn's preamble (core/prompts.ts), each a part of its own; the rest of it is the
// environment block and the run's settings.
const PREAMBLE_BLOCKS: [RegExp, string][] = [
  [/<project_instructions[\s>][\s\S]*?<\/project_instructions>/g, 'project instructions'],
  [/<project_memory>[\s\S]*?<\/project_memory>/g, 'memory'],
  [/<skills>[\s\S]*?<\/skills>/g, 'skills list'],
];

const modelOf = (ref: string): ModelSpec | undefined => {
  try {
    return resolveModel(ref);
  } catch {
    return undefined;
  }
};

// mcp__<server>__<tool> is an MCP server's tool (core/mcp/tools.ts); the rest are cedia's own.
const toolPart = (name: string) => {
  const m = /^mcp__(.+?)__/.exec(name);
  return m ? `tools: mcp ${m[1]}` : 'tools: built-in';
};

export function contextBreakdown(events: SessionEvent[], opts: { sessionId?: string; handoffAt?: number; top?: number } = {}): ContextBreakdown {
  const held = new Map<string, { group: ContextPart['group']; chars: number; count: number }>();
  const hold = (part: string, group: ContextPart['group'], chars: number, count = 0) => {
    const h = held.get(part) ?? { group, chars: 0, count: 0 };
    held.set(part, { group, chars: h.chars + chars, count: h.count + count });
  };
  const results: { callId: string; tool: string; chars: number }[] = [];
  const toolOf = new Map<string, string>();
  let modelRef = '';
  let model: ModelSpec | undefined;
  // Thinking a 'same-turn' model drops at the next user text (DeepSeek's tool loops).
  let turnThinking = 0;
  let preambled = false;
  // The last reply's measured context, and how many characters the session held then.
  let measured: { tokens: number; chars: number } | undefined;
  const total = () => [...held.values()].reduce((a, h) => a + h.chars, 0) + turnThinking;

  for (const e of events) {
    switch (e.kind) {
      case 'session':
        modelRef = e.model;
        model = modelOf(e.model);
        hold('system prompt', 'fixed', e.system.length);
        for (const t of e.tools) hold(toolPart(t.name), 'fixed', JSON.stringify(t).length, 1);
        break;
      case 'summary':
        hold('summary of earlier sessions', 'conversation', e.block.text.length + e.block.opaque.length);
        break;
      case 'user':
        hold('user', 'conversation', e.text.length);
        turnThinking = 0;
        break;
      case 'reminder': {
        if (e.as === 'user') turnThinking = 0;
        // The first user reminder before any user text is the preamble.
        if (!preambled && e.as === 'user' && /^<environment>/.test(e.text)) {
          preambled = true;
          let rest = e.text.length;
          for (const [re, part] of PREAMBLE_BLOCKS) {
            const chars = [...e.text.matchAll(re)].reduce((a, m) => a + m[0].length, 0);
            if (chars) hold(part, 'fixed', chars);
            rest -= chars;
          }
          hold('environment and settings', 'fixed', rest);
        } else hold('reminders', 'conversation', e.text.length);
        break;
      }
      case 'request':
        model = modelOf(e.model) ?? model;
        modelRef = e.model || modelRef;
        break;
      case 'assistant': {
        const m = modelOf(e.model) ?? model;
        for (const b of e.blocks) {
          if (b.type === 'text') hold('assistant text', 'conversation', b.text.length);
          else if (b.type === 'thinking') {
            const chars = b.text.length + (b.opaque?.length ?? 0);
            if (m?.caps.replayReasoning === 'same-turn') turnThinking += chars;
            else if (m?.caps.replayReasoning !== 'forbidden') hold('thinking', 'conversation', chars);
          } else if (b.type === 'tool_use') {
            toolOf.set(b.callId ?? b.id, b.name);
            hold('tool calls', 'conversation', b.name.length + JSON.stringify(b.input).length);
          }
        }
        const u = e.usage;
        const tokens = u.uncached + u.cacheRead + u.cacheWrite + u.output;
        if (tokens > 0) measured = { tokens, chars: total() };
        break;
      }
      case 'tool_intent':
        toolOf.set(e.callId, e.tool);
        break;
      case 'tool_result': {
        const tool = toolOf.get(e.callId) ?? 'unknown';
        hold(`tool results: ${tool}`, 'conversation', e.output.text.length, 1);
        results.push({ callId: e.callId, tool, chars: e.output.text.length });
        break;
      }
    }
  }
  if (turnThinking) hold('thinking', 'conversation', turnThinking);
  turnThinking = 0;

  const chars = total();
  const tokens = measured ? Math.max(0, Math.round(measured.tokens + (chars - measured.chars) / 4)) : Math.ceil(chars / 4);
  const perChar = chars ? tokens / chars : 0;
  const parts: ContextPart[] = [...held]
    .filter(([, h]) => h.chars > 0)
    .map(([part, h]) => ({ part, group: h.group, chars: h.chars, tokens: Math.round(h.chars * perChar), share: chars ? h.chars / chars : 0, ...(h.count ? { count: h.count } : {}) }))
    .sort((a, b) => b.chars - a.chars);
  const largest = results
    .sort((a, b) => b.chars - a.chars)
    .slice(0, opts.top ?? 5)
    .filter((r) => r.chars > 0)
    .map((r) => ({ callId: r.callId, tool: r.tool, tokens: Math.round(r.chars * perChar) }));
  return {
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    model: modelRef,
    ...(model ? { window: model.caps.contextWindow } : {}),
    ...(opts.handoffAt ? { handoffAt: opts.handoffAt } : {}),
    tokens,
    measured: !!measured,
    parts,
    largest,
  };
}

const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const BAR = 24;

// The session a thread's next prompt goes on in: its last writer session that a rewind did not leave behind.
export function writerSessionOf(t: Thread, cwd: string, home?: string): { sessionId: string; path: string } | undefined {
  const s = t.sessions.findLast((x) => x.role === 'code' && !x.rewound);
  return s && { sessionId: s.sessionId, path: s.path ?? sessionPath(cwd, s.sessionId, home) };
}

// A bar of the window: fixed parts, then the conversation, then what is free.
export function contextBar(c: ContextBreakdown, width = BAR): string {
  if (!c.window) return '';
  const fixed = c.parts.filter((p) => p.group === 'fixed').reduce((a, p) => a + p.tokens, 0);
  const cells = (n: number) => Math.min(width, Math.round((n / c.window!) * width));
  const f = cells(fixed);
  const all = Math.max(f, cells(c.tokens));
  return `[${'#'.repeat(f)}${'='.repeat(all - f)}${'.'.repeat(width - all)}]`;
}

export function formatContext(c: ContextBreakdown): string {
  const of = c.window ? ` of ${k(c.window)} (${pct(c.tokens / c.window)})` : '';
  const handoff = c.handoffAt ? `, hands off at ${k(c.handoffAt)}` : '';
  const lines = [`context: ${k(c.tokens)} tokens${of}${handoff}${c.measured ? '' : ' (estimated from characters)'}${c.model ? ` · ${c.model}` : ''}`];
  const bar = contextBar(c);
  if (bar) lines.push(`${bar}  # fixed  = conversation  . free`);
  for (const group of ['fixed', 'conversation'] as const) {
    const parts = c.parts.filter((p) => p.group === group);
    if (!parts.length) continue;
    const sum = parts.reduce((a, p) => a + p.tokens, 0);
    lines.push(group === 'fixed' ? `fixed, sent on every request: ${k(sum)}` : `conversation: ${k(sum)}`);
    for (const p of parts) lines.push(`  ${`${p.part}${p.count ? ` (${p.count})` : ''}`.padEnd(30)} ${k(p.tokens).padStart(6)}  ${pct(p.share).padStart(4)}`);
  }
  if (c.largest.length) lines.push(`largest tool results: ${c.largest.map((l) => `${l.tool} ${l.callId} ${k(l.tokens)}`).join(', ')}`);
  return lines.join('\n');
}
