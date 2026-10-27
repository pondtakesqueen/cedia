import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayOf, formatUsage, sinceOf, usageReport } from '../src/core/session/usage.ts';
import { threadsDir, ThreadStore } from '../src/core/project/threads.ts';
import type { SessionEvent, Usage } from '../src/core/types.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const at = (s: number) => new Date(Date.UTC(2026, 9, 22, 0, 0, s)).toISOString();
const usage = (cacheRead: number, uncached: number, output = 10): Usage => ({ uncached, cacheRead, cacheWrite: 0, output });

function events(): SessionEvent[] {
  let n = 0;
  const e = (body: Record<string, unknown>, s = n): SessionEvent => ({ id: `e${n++}`, at: at(s), ...body }) as unknown as SessionEvent;
  const req = (s: number, effort?: string) => e({ kind: 'request', model: 'anthropic/claude-haiku-5-5', toolsHash: 't', systemHash: 's', bodyHash: `b${s}`, headers: {}, ...(effort ? { effort } : {}) }, s);
  return [
    e({ kind: 'session', cwd: '/x', role: 'code', model: 'anthropic/claude-haiku-5-5', system: 'S'.repeat(100), tools: [] }),
    e({ kind: 'user', text: 'U'.repeat(50) }),
    req(1),
    e({ kind: 'assistant', wire: 'anthropic', model: 'anthropic/claude-haiku-5-5', blocks: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'cat big' } }], stop: 'tool_use', usage: usage(0, 2000) }, 2),
    e({ kind: 'tool_intent', callId: 'c1', tool: 'bash', input: { command: 'cat big' } }),
    e({ kind: 'tool_result', callId: 'c1', status: 'completed', output: { text: 'B'.repeat(10_000), isError: false } }),
    req(3),
    e({ kind: 'assistant', wire: 'anthropic', model: 'anthropic/claude-haiku-5-5', blocks: [{ type: 'text', text: 'ok' }], stop: 'end_turn', usage: usage(2000, 3000) }, 4),
    // Ten minutes later: past the 5-minute cache, and past Haiku's 100k price line.
    req(700, 'max'),
    e({ kind: 'assistant', wire: 'anthropic', model: 'anthropic/claude-haiku-5-5', blocks: [{ type: 'text', text: 'again' }], stop: 'end_turn', usage: usage(0, 120_000) }, 701),
    e({ kind: 'turn_end', reason: 'handoff' }, 702),
  ];
}

describe('cedia usage', () => {
  test('counts input by source as resent, the costliest results, misses, the price line, max effort and handoffs', () => {
    const r = usageReport([{ id: 's1', events: events() }]);
    expect(r.requests).toBe(3);
    const share = Object.fromEntries(r.sources.map((s) => [s.source, s.chars]));
    // The bash result arrived after the first request, so the second and third sent it: 2 x 10k.
    expect(share['tool: bash']).toBe(20_000);
    expect(share['system prompt and tools']).toBe(3 * 102);
    expect(share.user).toBe(150);
    expect(r.sources[0]!.source).toBe('tool: bash');
    expect(r.largest[0]).toEqual({ session: 's1', callId: 'c1', tool: 'bash', chars: 10_000, resent: 2 });
    expect(r.misses).toEqual([{ cause: 'idle_over_ttl', count: 1, tokens: 4992 }]); // whole cache blocks only
    expect([r.overPriceLine, r.maxEffort, r.handoffs]).toEqual([1, 1, 1]);
    expect(r.costUsd).toBeGreaterThan(0);
    const text = formatUsage(r);
    expect(text).toContain('cache misses: 1 idle_over_ttl (4992 tokens)');
    expect(text).toContain("1 request past the model's long-context price line; 1 request at effort max; 1 handoff");
    // The 10k bash result re-sent twice dominates resent input, so it earns a warning; always-on context does not.
    expect(r.warnings).toEqual(['tool result bash c1 (10k chars x 2) is 98% of resent input; have the model summarize it instead of re-reading it']);
    expect(text).toContain('warning: tool result bash c1 (10k chars x 2) is 98% of resent input');
  });

  test('attempts that wait 30s+ for the first byte count as slow starts', () => {
    let n = 0;
    const e = (body: Record<string, unknown>): SessionEvent => ({ id: `e${n++}`, at: at(n), ...body }) as unknown as SessionEvent;
    const events = [
      e({ kind: 'session', cwd: '/x', role: 'code', model: 'anthropic/claude-haiku-5-5', system: '', tools: [] }),
      e({ kind: 'request', model: 'm', toolsHash: 't', systemHash: 's', bodyHash: 'b', headers: {} }),
      e({ kind: 'attempt', requestId: 'q', n: 1, ttftMs: 45_000, ms: 46_000 }),
      e({ kind: 'attempt', requestId: 'q', n: 2, ttftMs: 200, ms: 900 }),
    ];
    const r = usageReport([{ id: 's', events }]);
    expect(r.slowStart).toBe(1);
    expect(formatUsage(r)).toContain('1 attempt waited 30s+ for the first byte');
  });

  test('always-on context past a quarter of resent input earns a warning; one request never does', () => {
    let n = 0;
    const e = (body: Record<string, unknown>): SessionEvent => ({ id: `e${n++}`, at: at(n), ...body }) as unknown as SessionEvent;
    const sys = 'S'.repeat(10_000);
    const one = [{ id: 's', events: [e({ kind: 'session', cwd: '/x', role: 'code', model: 'anthropic/claude-haiku-5-5', system: sys, tools: [] }), e({ kind: 'user', text: 'hi' }), e({ kind: 'request', model: 'm', toolsHash: 't', systemHash: 's', bodyHash: 'b', headers: {} })] }];
    expect(usageReport(one).warnings).toEqual([]);
    const two = [{ id: 's', events: [...one[0]!.events, e({ kind: 'request', model: 'm', toolsHash: 't', systemHash: 's', bodyHash: 'b2', headers: {} })] }];
    const r = usageReport(two);
    expect(r.warnings).toEqual(['always-on context (system prompt and tools) is 100% of resent input across 2 requests; slim the prompt, tools, memory or instructions']);
    expect(formatUsage(r)).toContain('warning: always-on context (system prompt and tools) is 100%');
  });

  test("counts thinking by the model's replay rule: DeepSeek sends it back only until the next user text", () => {
    const m = 'opencode-go/deepseek-v4.1-flash';
    let n = 0;
    const e = (body: Record<string, unknown>): SessionEvent => ({ id: `e${n}`, at: at(n++), ...body }) as unknown as SessionEvent;
    const req = () => e({ kind: 'request', model: m, toolsHash: 't', systemHash: 's', bodyHash: `b${n}`, headers: {} });
    const think = (text: string) => e({ kind: 'assistant', wire: 'openai-chat', model: m, blocks: [{ type: 'thinking', text }, { type: 'text', text: '' }], stop: 'end_turn', usage: usage(0, 10) });
    const r = usageReport([{ id: 's', events: [e({ kind: 'session', cwd: '/x', role: 'code', model: m, system: '', tools: [] }), req(), think('T'.repeat(100)), req(), e({ kind: 'user', text: 'next' }), req()] }]);
    expect(r.sources.find((s) => s.source === 'thinking')?.chars).toBe(100);
    // A reminder sent as user text ends the turn on the wire too; one sent as system does not.
    const head = () => [e({ kind: 'session', cwd: '/x', role: 'code', model: m, system: '', tools: [] }), req(), think('T'.repeat(100))];
    const asUser = usageReport([{ id: 's', events: [...head(), e({ kind: 'reminder', as: 'user', text: 'r' }), req()] }]);
    const asSystem = usageReport([{ id: 's', events: [...head(), e({ kind: 'reminder', as: 'system', text: 'r' }), req()] }]);
    expect([asUser, asSystem].map((x) => x.sources.find((s) => s.source === 'thinking')?.chars)).toEqual([undefined, 100]);
  });

  test('an escalation to max counts the requests after it; an unknown model is named, not priced', () => {
    let n = 0;
    const e = (body: Record<string, unknown>): SessionEvent => ({ id: `e${n}`, at: at(n++), ...body }) as unknown as SessionEvent;
    const req = (model = 'anthropic/claude-haiku-5-5') => e({ kind: 'request', model, effort: 'low', toolsHash: 't', systemHash: 's', bodyHash: `b${n}`, headers: {} });
    const reply = (model = 'anthropic/claude-haiku-5-5') => e({ kind: 'assistant', wire: 'anthropic', model, blocks: [{ type: 'text', text: 'x' }], stop: 'end_turn', usage: usage(0, 10) });
    const r = usageReport([{ id: 's', events: [e({ kind: 'session', cwd: '/x', role: 'code', model: 'anthropic/claude-haiku-5-5', system: '', tools: [] }), req(), reply(), e({ kind: 'effort', effort: 'max' }), req(), reply(), req(), reply(), req('someone/else'), reply('someone/else')] }]);
    expect([r.maxEffort, r.unpriced]).toEqual([3, 1]);
  });

  test('a session from a summary bills its compaction once and its copied turns not again', () => {
    const m = 'anthropic/claude-haiku-5-5';
    let n = 0;
    const e = (body: Record<string, unknown>): SessionEvent => ({ id: `e${n}`, at: at(n++), ...body }) as unknown as SessionEvent;
    const req = () => e({ kind: 'request', model: m, toolsHash: 't', systemHash: 's', bodyHash: `b${n}`, headers: {} });
    const reply = (text: string) => e({ kind: 'assistant', wire: 'anthropic', model: m, blocks: [{ type: 'text', text }], stop: 'end_turn', usage: usage(0, 1000) });
    const block = { type: 'compaction', text: 'S'.repeat(40), opaque: 'O'.repeat(60) };
    const first = [e({ kind: 'session', cwd: '/x', role: 'code', model: m, system: '', tools: [] }), e({ kind: 'user', text: 'task' }), req(), reply('a'), req(), reply('b')];
    first.push(e({ kind: 'compaction', requestId: first[2]!.id, stop: 'compaction', usage: usage(0, 1000, 100), block }));
    const one = usageReport([{ id: 'a', events: first }]);
    const second = [e({ kind: 'session', cwd: '/x', role: 'code', model: m, system: '', tools: [] }), e({ kind: 'summary', session: 'a', block, kept: 2 }), req(), reply('b'), e({ kind: 'user', text: 'more' }), req(), reply('c')];
    const both = usageReport([{ id: 'a', events: first }, { id: 'b', events: second }]);
    // The copied request and reply were the first session's: one more request and one more reply's cost.
    expect(both.requests).toBe(one.requests + 1);
    expect(both.compactUsd).toBeGreaterThan(0);
    const perReply = (one.costUsd - one.compactUsd) / 2;
    expect(both.costUsd).toBeCloseTo(one.costUsd + perReply, 10);
    expect(both.sources.find((s) => s.source === 'summary')?.chars).toBe(100);
    expect(formatUsage(both)).toContain('summarizing for handoffs');
  });

  test('reads log files from the command line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-usage-'));
    const file = join(dir, 's1.jsonl');
    // The last line was cut mid-write: the report reads the rest.
    writeFileSync(file, events().map((e) => JSON.stringify(e)).join('\n') + '\n{"id":"cut","kind":"assi');
    const p = Bun.spawnSync([BIN, 'usage', file, '--json']);
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toMatchObject({ sessions: 1, requests: 3, handoffs: 1 });
    expect(Bun.spawnSync([BIN, 'usage', '--cwd', dir], { env: { ...process.env, CEDIA_HOME: join(dir, 'home') } }).exitCode).toBe(1);
  });

  test('splits the cost by local day, model, project and thread, and leaves out spend before --since', () => {
    const haiku = 'anthropic/claude-haiku-5-5';
    const deepseek = 'opencode-go/deepseek-v4.1-flash';
    let n = 0;
    const session = (model: string, day: number) => {
      const when = (h: number) => new Date(2026, 9, day, h).toISOString();
      const e = (body: Record<string, unknown>, h: number): SessionEvent => ({ id: `e${n++}`, at: when(h), ...body }) as unknown as SessionEvent;
      return [
        e({ kind: 'session', cwd: '/x', role: 'code', model, system: '', tools: [] }, 9),
        e({ kind: 'request', model, toolsHash: 't', systemHash: 's', bodyHash: `b${n}`, headers: {} }, 9),
        e({ kind: 'assistant', wire: 'anthropic', model, blocks: [{ type: 'text', text: 'x' }], stop: 'end_turn', usage: usage(0, 1000) }, 9),
      ];
    };
    const sessions = [
      { id: 'a', events: session(haiku, 20), project: 'p1', thread: 't-1', title: 'first' },
      { id: 'b', events: session(haiku, 21), project: 'p1', thread: 't-1', title: 'first' },
      { id: 'c', events: session(deepseek, 21), project: 'p2', thread: 't-2', title: 'second' },
    ];
    const r = usageReport(sessions);
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-20', '2026-10-21']);
    expect(r.days.reduce((a, d) => a + d.costUsd, 0)).toBeCloseTo(r.costUsd, 10);
    expect(r.models.map((m) => [m.model, m.requests])).toEqual(
      r.models[0]!.model === haiku ? [[haiku, 2], [deepseek, 1]] : [[deepseek, 1], [haiku, 2]],
    );
    expect(r.projects.find((p) => p.project === 'p1')!.costUsd).toBeGreaterThan(0);
    expect(r.threads.find((t) => t.thread === 't-1')).toMatchObject({ title: 'first', project: 'p1' });
    // From the 21st: the 20th's reply is not billed, though its session was read.
    const later = usageReport(sessions, { since: new Date(2026, 9, 21) });
    expect(later.days.map((d) => d.day)).toEqual(['2026-10-21']);
    expect(later.models.find((m) => m.model === haiku)!.requests).toBe(1);
    expect(later.sessions).toBe(3);
  });

  test('--since takes a day or a number of days counting today', () => {
    const now = new Date(2026, 9, 22, 15, 30);
    expect(dayOf(sinceOf('7d', now))).toBe('2026-10-16');
    expect(dayOf(sinceOf('1d', now))).toBe('2026-10-22');
    expect(sinceOf('2026-10-01', now)).toEqual(new Date(2026, 9, 1));
    expect(() => sinceOf('last week', now)).toThrow('--since');
    expect(() => sinceOf('0d', now)).toThrow('--since');
  });

  test('--all reads every project and names each session\'s thread', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-usage-all-'));
    for (const [project, title] of [['p1', 'fix the build'], ['p2', 'write docs']] as const) {
      const store = new ThreadStore(threadsDir(home, project));
      const id = store.open(title);
      store.append(id, { kind: 'session', sessionId: `s-${project}`, model: 'anthropic/claude-haiku-5-5', role: 'code', why: 'start' });
      mkdirSync(join(home, 'sessions', project), { recursive: true });
      writeFileSync(join(home, 'sessions', project, `s-${project}.jsonl`), events().map((e) => JSON.stringify(e)).join('\n'));
    }
    const env = { ...process.env, CEDIA_HOME: home };
    const p = Bun.spawnSync([BIN, 'usage', '--all', '--since', '30d', '--json'], { env });
    expect(p.exitCode).toBe(0);
    const r = JSON.parse(p.stdout.toString());
    expect(r.sessions).toBe(2);
    expect(r.projects.map((x: { project: string }) => x.project).sort()).toEqual(['p1', 'p2']);
    expect(r.threads.map((x: { title: string }) => x.title).sort()).toEqual(['fix the build', 'write docs']);
    // A range with no session in it is still an answer.
    const empty = Bun.spawnSync([BIN, 'usage', '--all', '--since', '2099-01-01', '--json'], { env });
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(empty.stdout.toString())).toMatchObject({ sessions: 0, costUsd: 0, days: [] });
  });
});

describe('blocked calls', () => {
  test('denials and hook blocks count by rule; allows do not', () => {
    let n = 0;
    const e = (body: Record<string, unknown>): SessionEvent => ({ id: `e${n}`, at: at(n++), ...body }) as unknown as SessionEvent;
    const m = 'anthropic/claude-haiku-5-5';
    const r = usageReport([
      {
        id: 's',
        events: [
          e({ kind: 'session', cwd: '/x', role: 'code', model: m, system: '', tools: [] }),
          e({ kind: 'permission', callId: 'c1', tool: 'bash', decision: 'deny', rule: 'deny:bash(rm *)' }),
          e({ kind: 'permission', callId: 'c2', tool: 'bash', decision: 'deny', rule: 'deny:bash(rm *)' }),
          e({ kind: 'permission', callId: 'c3', tool: 'bash', decision: 'deny', rule: 'classifier', reason: 'reaches past the project' }),
          e({ kind: 'permission', callId: 'c4', tool: 'read', decision: 'allow', rule: 'effect:read' }),
          e({ kind: 'hook', hook: 'no-curl', event: 'preToolUse', callId: 'c5', decision: 'block', ms: 3 }),
        ],
      },
    ]);
    expect(r.blocked).toEqual([
      { rule: 'deny:bash(rm *)', count: 2 },
      { rule: 'classifier', count: 1 },
      { rule: 'hook:no-curl', count: 1 },
    ]);
    expect(formatUsage(r)).toContain('blocked calls: 2 deny:bash(rm *), 1 classifier, 1 hook:no-curl');
  });
});

describe('daily spend warn', () => {
  const rich = (id: string, at: string): SessionEvent[] => [
    { id: `${id}-0`, at, kind: 'session', cwd: '/x', role: 'code', model: 'anthropic/claude-haiku-5-5', system: '', tools: [] },
    { id: `${id}-1`, at, kind: 'assistant', wire: 'anthropic', model: 'anthropic/claude-haiku-5-5', blocks: [{ type: 'text', text: 'x' }], stop: 'end_turn', usage: { uncached: 300_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } },
  ] as unknown as SessionEvent[];
  test('daySpendUsd totals today only, and stays silent on an empty home', async () => {
    const { daySpendUsd } = await import('../src/core/session/select.ts');
    const { projectKey } = await import('../src/core/session/log.ts');
    const home = mkdtempSync(join(tmpdir(), 'cedia-spend-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-spend-ws-'));
    expect(daySpendUsd(home, cwd)).toBe(0);
    const dir = join(home, 'sessions', projectKey(cwd));
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).toISOString();
    const old = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 12).toISOString();
    writeFileSync(join(dir, 'today.jsonl'), rich('t', today).map((e) => JSON.stringify(e)).join('\n'));
    writeFileSync(join(dir, 'old.jsonl'), rich('o', old).map((e) => JSON.stringify(e)).join('\n'));
    // 300M uncached Haiku is past its 100k long-context line: billed at the above-line price (0.5/M).
    expect(daySpendUsd(home, cwd)).toBeCloseTo(150, 5);
  });
});
