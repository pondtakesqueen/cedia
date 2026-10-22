import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatUsage, usageReport } from '../src/core/session/usage.ts';
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
});
