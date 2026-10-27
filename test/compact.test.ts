import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeMisses } from '../src/core/context/cache.ts';
import { buildMessages } from '../src/core/context/build.ts';
import { rebuildRequest, runPrompt } from '../src/core/loop/run.ts';
import { compactedNote, compactionCut, compactPlan, firstReply, seedCompacted } from '../src/core/project/compact.ts';
import { contextSize, HANDOFF_PROMPT } from '../src/core/project/handoff.ts';
import { anthropicBody, anthropicProvider, COMPACTION_BETA, parseAnthropic } from '../src/core/providers/anthropic.ts';
import { resolveModel } from '../src/core/providers/catalog.ts';
import { fauxProvider, type FauxStep } from '../src/core/providers/faux.ts';
import { streamFromString } from '../src/core/providers/sse.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { projectSlug, SessionLog } from '../src/core/session/log.ts';
import { CORE_TOOLS } from '../src/core/tools/index.ts';
import type { CompactionBlock, EventOf, SessionEvent, StreamEvent } from '../src/core/types.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'cedia-compact-'));
const reply = (text: string) => ({ blocks: [{ type: 'text' as const, text }] });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ blocks: [{ type: 'tool_use' as const, id, name, input }] });
const call = (id: string, command: string) => tool(id, 'bash', { command });
const block: CompactionBlock = { type: 'compaction', text: 'SUMMARY: wrote f.txt; next, run the check.', opaque: 'sig-1' };
const summary = { blocks: [block], stop: 'compaction' as const };
const noSummary = { blocks: [], stop: 'end_turn' as const };
const of = <K extends SessionEvent['kind']>(events: SessionEvent[], kind: K) => events.filter((e): e is EventOf<K> => e.kind === kind);

describe('handoff by compaction in the loop', () => {
  const model = resolveModel('faux');
  const big = 'x'.repeat(40_000);
  const bigTool = { ...CORE_TOOLS[0]!, name: 'big', effect: 'read' as const, pathOf: undefined, run: async () => ({ text: big, isError: false }) };
  const write = tool('w1', 'write', { path: 'f.txt', content: 'x' });
  const run = (script: FauxStep[], extra: Partial<Parameters<typeof runPrompt>[0]> = {}, log = SessionLog.create()) => {
    const provider = fauxProvider(script);
    const permission = { mode: 'workspace' as const, allow: [], deny: [] };
    return runPrompt({ log, provider, model, tools: [...CORE_TOOLS, bigTool], system: 'sys', cwd: tmp(), permission, ...extra }, 'do it').then((r) => ({ r, log, provider }));
  };
  const compact = { startAt: 2000, keepTokens: 500 };

  test('starts in the background past startAt, goes on, and ends with the summary at the next turn boundary', async () => {
    const { r, log } = await run([write, tool('c1', 'big', {}), summary, call('c2', 'ls'), reply('never reached')], { handoffAt: 1_000_000, compact });
    expect(r).toMatchObject({ subtype: 'handoff', result: block.text, compaction: { block } });
    const [sent] = of(log.events, 'compact_request');
    // It summarized up to the request whose reply called `big`: at least keepTokens of the newest context is kept.
    const cut = log.events.findIndex((e) => e.id === sent!.of);
    expect(log.events[cut + 2]).toMatchObject({ kind: 'assistant', blocks: [{ type: 'tool_use', id: 'c1' }] });
    expect(r.compaction!.of).toBe(sent!.of);
    expect(of(log.events, 'compaction')).toMatchObject([{ requestId: sent!.id, stop: 'compaction', block }]);
    // The session went on while the summary was written: c2 ran after the compaction request was sent.
    const ran = log.events.findIndex((e) => e.kind === 'tool_result' && e.callId === 'c2');
    expect(ran).toBeGreaterThan(log.events.indexOf(sent!));
    expect(log.events.some((e) => e.kind === 'reminder' && e.text === HANDOFF_PROMPT)).toBe(false);
    expect(log.events.at(-1)).toMatchObject({ kind: 'turn_end', reason: 'handoff' });
    expect(lintSession(log.events)).toEqual([]);
  });

  test('the compaction request carries exactly the messages of the request it summarizes', async () => {
    const { log, provider } = await run([write, tool('c1', 'big', {}), summary, call('c2', 'ls'), reply('x')], { handoffAt: 1_000_000, compact });
    const sent = of(log.events, 'compact_request')[0]!;
    const at = log.events.findIndex((e) => e.id === sent.of);
    const asked = provider.state.bodies[2] as { messages: unknown };
    expect(asked.messages).toEqual(rebuildRequest(log.events, at, model, log.id).messages);
  });

  test('at handoffAt it waits for the summary instead of growing on', async () => {
    const { r, log } = await run([write, tool('c1', 'big', {}), summary, reply('never reached')], { handoffAt: 2000, compact });
    expect(r).toMatchObject({ subtype: 'handoff', compaction: { block } });
    expect(of(log.events, 'request')).toHaveLength(2);
    expect(lintSession(log.events)).toEqual([]);
  });

  test('no summary twice: the second miss hands the handoff to the note', async () => {
    // A third miss is never asked for: the trailing noSummary stays unconsumed with exactly two requests sent.
    const { r, log } = await run([write, tool('c1', 'big', {}), noSummary, tool('c2', 'big', {}), noSummary, tool('c3', 'big', {}), reply('the note'), noSummary], { handoffAt: 12_000, compact });
    expect(r).toMatchObject({ subtype: 'handoff', result: 'the note' });
    expect(r.compaction).toBeUndefined();
    expect(of(log.events, 'compact_request')).toHaveLength(2);
    expect(of(log.events, 'compaction')).toMatchObject([{ stop: 'end_turn' }, { stop: 'end_turn' }]);
    expect(log.events.some((e) => e.kind === 'reminder' && e.text === HANDOFF_PROMPT)).toBe(true);
    expect(lintSession(log.events)).toEqual([]);
  });

  test('one miss is asked once more: a summary on the retry hands off by compaction', async () => {
    // Consumption order: t1 write, t2 big, C1 noSummary, t3 big, C2 summary, t4 big; t5 ends at the summary.
    const { r, log } = await run([write, tool('c1', 'big', {}), noSummary, tool('c2', 'big', {}), summary, tool('c3', 'big', {})], { handoffAt: 12_000, compact });
    expect(r).toMatchObject({ subtype: 'handoff', result: block.text, compaction: { block } });
    expect(of(log.events, 'compact_request')).toHaveLength(2);
    expect(log.events.some((e) => e.kind === 'reminder' && e.text === HANDOFF_PROMPT)).toBe(false);
    expect(lintSession(log.events)).toEqual([]);
  });

  test('a session that ends first stops the compaction and logs that before its end', async () => {
    const { r, log } = await run([write, tool('c1', 'big', {}), { hang: true }, reply('done')], { handoffAt: 1_000_000, compact });
    expect(r.subtype).toBe('success');
    expect(of(log.events, 'compaction')).toMatchObject([{ stop: 'aborted', error: { message: 'aborted: the session ended first' } }]);
    expect(log.events.at(-1)).toMatchObject({ kind: 'turn_end', reason: 'completed' });
    expect(lintSession(log.events)).toEqual([]);
  });

  test('a model that does not take compaction requests hands off by note', async () => {
    const { r } = await run([write, tool('c1', 'big', {}), reply('the note')], { handoffAt: 2000, compact, model: { ...model, compaction: false } });
    expect(r).toMatchObject({ subtype: 'handoff', result: 'the note' });
  });

  test('the next session starts from the summary and the kept turns, copied, and goes on', async () => {
    const a = await run([write, tool('c1', 'big', {}), summary, call('c2', 'ls'), reply('x')], { handoffAt: 1_000_000, compact });
    const b = SessionLog.create();
    seedCompacted(a.log, b, a.r.compaction!);
    expect(b.events[0]).toMatchObject({ kind: 'session', system: 'sys', parentSession: a.log.id });
    expect((b.events[0] as EventOf<'session'>).tools).toEqual((a.log.events[0] as EventOf<'session'>).tools);
    const head = b.events[1] as EventOf<'summary'>;
    expect(head).toMatchObject({ kind: 'summary', session: a.log.id, block });
    // The copies are A's events from the summarized request on, less A's compaction and end, with new ids.
    const cut = a.log.events.findIndex((e) => e.id === a.r.compaction!.of);
    const kept = a.log.events.slice(cut).filter((e) => !['compact_request', 'compaction', 'turn_end'].includes(e.kind));
    expect(head.kept).toBe(kept.length);
    expect(b.events.slice(2).map((e) => e.kind)).toEqual(kept.map((e) => e.kind));
    expect(b.events.slice(2).some((e) => a.log.events.some((x) => x.id === e.id))).toBe(false);
    expect(lintSession([...b.events, { ...b.events.at(-1)!, kind: 'turn_end', reason: 'completed', id: 'end' as never, parentId: b.leaf!.id }] as SessionEvent[])).toEqual([]);
    // The messages after the summary are A's messages after the summarized request, unchanged.
    const msgs = buildMessages(b.events);
    expect(msgs[0]).toEqual({ role: 'assistant', wire: 'anthropic-messages', blocks: [block] });
    expect(msgs.slice(1)).toEqual(buildMessages(a.log.events).slice(buildMessages(a.log.events.slice(0, cut)).length));

    const next = await run([call('c3', 'cat f.txt'), reply('all done')], { continues: { sessionId: a.log.id, changed: ['f.txt'] }, preamble: compactedNote(a.log.id) }, b);
    expect(next.r.subtype).toBe('success');
    const first = next.provider.state.bodies[0] as { messages: unknown[] };
    expect(first.messages[0]).toEqual({ role: 'assistant', wire: 'anthropic-messages', blocks: [block] });
    expect(lintSession(b.events)).toEqual([]);
    // Cache attribution starts over after the copied turns: the first request of its own is the cold one.
    expect(attributeMisses(b.events, { blockTokens: 16 }).map((r) => r.cause)).toEqual(['cold', undefined]);
  });

  test('a session that started from a summary compacts again once it grew by the kept share, not only when doubled', async () => {
    const a = await run([write, tool('c1', 'big', {}), summary, call('c2', 'ls'), reply('x')], { handoffAt: 1_000_000, compact });
    const b = SessionLog.create();
    seedCompacted(a.log, b, a.r.compaction!);
    // Its first reply of its own sees ~11k (the summary and the copied turns); one more big result brings ~21k, short
    // of doubled but more than keepTokens past it.
    const next = await run([write, tool('c4', 'big', {}), summary, call('c5', 'ls'), reply('x')], { handoffAt: 1_000_000, compact: { startAt: 15_000, keepTokens: 5_000 }, continues: { sessionId: a.log.id, changed: [] } }, b);
    expect(next.r).toMatchObject({ subtype: 'handoff', compaction: { block } });
    const own = firstReply(b.events, b.events.findIndex((e) => e.kind === 'user'))!;
    expect(contextSize(own.usage)).toBeGreaterThan(9_000);
    // The cut is a request of this session, never a copied one.
    const ownStart = b.events.findIndex((e) => e.kind === 'user');
    expect(b.events.findIndex((e) => e.id === next.r.compaction!.of)).toBeGreaterThan(ownStart);
  });
});

describe('compaction cut', () => {
  const ev = (kind: string, extra: object = {}) => ({ id: crypto.randomUUID(), parentId: null, at: '', kind, ...extra }) as unknown as SessionEvent;
  const usage = (input: number) => ({ uncached: input, cacheRead: 0, cacheWrite: 0, output: 10 });
  const said = (input: number, blocks: object[] = [{ type: 'text', text: 'ok' }]) => ev('assistant', { blocks, stop: 'end_turn', usage: usage(input) });

  test('the latest request whose reply saw at most size - keep, with something said', () => {
    const events = [ev('request'), said(1000), ev('request'), said(5000), ev('request'), said(9000), ev('request'), said(9500, [{ type: 'thinking', text: '', opaque: 's' }])];
    expect(compactionCut(events, 0, 10_000, 4000)).toBe(2);
    expect(compactionCut(events, 0, 10_000, 500)).toBe(4);
    expect(compactionCut(events, 3, 10_000, 4000)).toBeUndefined();
    expect(compactionCut(events, 0, 10_000, 9000)).toBe(0);
    expect(compactionCut(events, 0, 10_000, 9999)).toBeUndefined();
  });

  test("a session from a summary measures doubling from its own first reply, not a copied one", () => {
    const copied = said(50_000);
    const own = said(11_000);
    const events = [ev('session'), ev('summary'), ev('request'), copied, ev('user'), ev('request'), own];
    expect(firstReply(events, 4)).toBe(own as never);
    expect(firstReply(events.filter((e) => e.kind !== "summary"), 3)).toBe(copied as never);
  });

  test('start and keep scale with the handoff point', () => {
    expect(compactPlan(90_000)).toEqual({ startAt: 76_500, keepTokens: 22_500 });
  });
});

describe('anthropic wire', () => {
  const model = resolveModel('anthropic/claude-haiku-5-5');
  const messages = buildMessages([
    { id: '1', parentId: null, at: '', kind: 'summary', session: 's', block, kept: 1 },
    { id: '2', parentId: null, at: '', kind: 'assistant', wire: 'anthropic-messages', model: 'm', blocks: [{ type: 'thinking', text: '', opaque: 'th' }, { type: 'text', text: 'hi' }], stop: 'end_turn', usage: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 } },
    { id: '3', parentId: null, at: '', kind: 'user', text: 'go on' },
  ] as SessionEvent[]);
  const req = { model, sessionId: 's', system: 'SYS', tools: [], messages, maxTokens: 1000 };

  test('the summary goes first as an assistant message of its own, with the beta header', () => {
    const b = anthropicBody(req) as any;
    expect(b.messages.map((m: any) => [m.role, m.content.map((c: any) => c.type)])).toEqual([['assistant', ['compaction']], ['assistant', ['thinking', 'text']], ['user', ['text']]]);
    expect(b.messages[0].content[0]).toEqual({ type: 'compaction', content: block.text, signature: block.opaque });
    expect(b.compaction).toBeUndefined();
    process.env.CEDIA_ANTHROPIC_API_KEY ||= 'test-key';
    expect(anthropicProvider().headers(req)['anthropic-beta']).toBe(COMPACTION_BETA);
  });

  test('a compaction request asks for a summary; requests without a block carry no beta header', () => {
    const plain = { ...req, messages: messages.slice(1) };
    const b = anthropicBody({ ...plain, compaction: { instructions: 'SUM' } }) as any;
    expect(b.compaction).toEqual({ type: 'summarize', instructions: 'SUM' });
    process.env.CEDIA_ANTHROPIC_API_KEY ||= 'test-key';
    expect(anthropicProvider().headers({ ...plain, compaction: { instructions: 'SUM' } })['anthropic-beta']).toBe(COMPACTION_BETA);
    expect(anthropicProvider().headers(plain)['anthropic-beta']).toBeUndefined();
    const fast = resolveModel('opus-fast');
    expect(anthropicProvider().headers({ ...req, model: fast })['anthropic-beta']).toBe(`fast-mode-2026-02-01,${COMPACTION_BETA}`);
  });

  test('parses the whole block, the compaction stop and the usage the iterations report', async () => {
    const out: StreamEvent[] = [];
    for await (const e of parseAnthropic(streamFromString(readFileSync(join(import.meta.dir, 'fixtures/sse/anthropic-compaction.sse'), 'utf8'), 13))) out.push(e);
    const done = out.find((e): e is Extract<StreamEvent, { type: 'done' }> => e.type === 'done')!;
    expect(done.stop).toBe('compaction');
    expect(done.blocks).toEqual([{ type: 'compaction', text: 'We identified the main entities: Recipe, Ingredient, Step and RecipeIngredient. Next: field names for Recipe.', opaque: 'CAIS2AkKHggTGALy' }]);
    expect(done.usage).toEqual({ uncached: 106, cacheRead: 9000, cacheWrite: 20, output: 276 });
  });

  test('only the Claude API models take compaction requests', () => {
    expect(resolveModel('anthropic/claude-haiku-5-5').compaction).toBe(true);
    expect(resolveModel('haiku').compaction).toBeUndefined();
  });
});

// End to end through bin/cedia: the writer goes on in a new session that starts from the summary.
describe('cedia --handoff compact (offline, faux)', () => {
  const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
  test('the second session holds the summary and the kept turns, and the thread records the summary as its handoff', () => {
    const dir = tmp();
    // Bulk through the read tool: the handoff measures what the context holds (bash output is capped).
    const big = '/tmp/cedia-handoff-big.txt';
    const script = [
      call('c1', `echo good > f.txt && seq 1 30000 > ${big} && echo wrote`),
      tool('r1', 'read', { path: big }),
      summary,
      call('c2', 'grep -q good f.txt'),
      reply('done, checked'),
    ];
    const scriptPath = join(dir, 'script.json');
    writeFileSync(scriptPath, JSON.stringify(script));
    const args = ['-m', 'faux', '--cwd', dir, '-p', 'make f.txt say good', '--output-format', 'json', '--permission', 'workspace', '--sandbox', 'off', '--check', 'grep -q good f.txt', '--spawn', 'off', '--handoff-at', '6000', '--handoff', 'compact'];
    const proc = Bun.spawnSync([BIN, ...args], { env: { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: join(dir, 'home') }, stdin: 'ignore' });
    const err = proc.stderr.toString();
    const result = JSON.parse(proc.stdout.toString());
    expect(result).toMatchObject({ subtype: 'success', result: 'done, checked' });
    expect(result.sessions).toHaveLength(2);
    expect(err).toContain('context reached 6000 tokens; going on in a new session from a summary of its older turns');
    const root = join(dir, 'home', 'sessions', projectSlug(dir));
    const logs = readdirSync(root).map((f) => SessionLog.load(join(root, f)));
    const [first, second] = result.sessions.map((id: string) => logs.find((l) => l.id === id)!);
    expect(second.events[1]).toMatchObject({ kind: 'summary', session: first.id, block });
    const text = second.events.filter((e: SessionEvent): e is EventOf<'reminder' | 'user'> => e.kind === 'reminder' || e.kind === 'user').map((e: EventOf<'reminder' | 'user'>) => e.text).join('\n');
    expect(text).toContain(compactedNote(first.id));
    expect(text).toContain('make f.txt say good');
    for (const l of [first, second]) expect(lintSession(l.events)).toEqual([]);
  });
});
