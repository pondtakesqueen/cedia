import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextBar, contextBreakdown, formatContext, writerSessionOf } from '../src/core/context/breakdown.ts';
import { awayRecap, formatRecap, lastRunStart, recapSince, spanText } from '../src/core/project/recap.ts';
import { threadsDir, ThreadStore } from '../src/core/project/threads.ts';
import { AWAY_MS, awayText, presentIn, recapWhen } from '../src/clients/tui-ink/away.ts';
import type { HeadlessResult, SessionEvent, Usage } from '../src/core/types.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const HAIKU = 'anthropic/claude-haiku-5-5';
const at = (s: number) => new Date(Date.UTC(2026, 9, 29, 10, 0, s)).toISOString();
const usage = (input: number, output = 0): Usage => ({ uncached: input, cacheRead: 0, cacheWrite: 0, output });

const PREAMBLE = `<environment>\nworking directory: /x\n</environment>\n<project_instructions path="AGENTS.md">\n${'I'.repeat(400)}\n</project_instructions>\n<project_memory>\n${'M'.repeat(200)}\n</project_memory>\n<skills>\n${'K'.repeat(100)}\n</skills>`;

function session(extra: Record<string, unknown>[] = []): SessionEvent[] {
  let n = 0;
  const e = (body: Record<string, unknown>): SessionEvent => ({ id: `e${n}`, at: at(n++), ...body }) as unknown as SessionEvent;
  return [
    e({
      kind: 'session', cwd: '/x', role: 'code', model: HAIKU, system: 'S'.repeat(2000),
      tools: [
        { name: 'read', description: 'r'.repeat(300), schema: {} },
        { name: 'bash', description: 'b'.repeat(300), schema: {} },
        { name: 'mcp__github__search', description: 'g'.repeat(500), schema: {} },
      ],
    }),
    e({ kind: 'reminder', as: 'user', text: PREAMBLE }),
    e({ kind: 'user', text: 'U'.repeat(100) }),
    e({ kind: 'request', model: HAIKU, toolsHash: 't', systemHash: 's', bodyHash: 'b1', headers: {} }),
    e({ kind: 'assistant', wire: 'anthropic-messages', model: HAIKU, blocks: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } }], stop: 'tool_use', usage: usage(1500, 20) }),
    e({ kind: 'tool_intent', callId: 'c1', tool: 'read', input: { path: 'a.ts' } }),
    e({ kind: 'tool_result', callId: 'c1', status: 'completed', output: { text: 'R'.repeat(8000), isError: false } }),
    ...extra.map(e),
  ];
}

describe('context breakdown', () => {
  test('splits the context into the system prompt, tools by server, the preamble blocks and history by kind', () => {
    const c = contextBreakdown(session(), { sessionId: 's1', handoffAt: 100_000 });
    const part = Object.fromEntries(c.parts.map((p) => [p.part, p]));
    expect(part['system prompt']).toMatchObject({ group: 'fixed', chars: 2000 });
    expect(part['tools: built-in']).toMatchObject({ group: 'fixed', count: 2 });
    expect(part['tools: mcp github']).toMatchObject({ group: 'fixed', count: 1 });
    expect(part['project instructions']!.chars).toBeGreaterThan(400);
    expect(part.memory!.chars).toBeGreaterThan(200);
    expect(part['skills list']!.chars).toBeGreaterThan(100);
    expect(part['environment and settings']!.group).toBe('fixed');
    // The four preamble parts add up to the preamble.
    expect(['project instructions', 'memory', 'skills list', 'environment and settings'].reduce((a, k) => a + part[k]!.chars, 0)).toBe(PREAMBLE.length);
    expect(part.user).toMatchObject({ group: 'conversation', chars: 100 });
    expect(part['tool results: read']).toMatchObject({ group: 'conversation', chars: 8000, count: 1 });
    expect(c.parts[0]!.part).toBe('tool results: read');
    // Measured: the last reply's 1520 tokens plus a quarter of the 8000 characters that came after it.
    expect(c.measured).toBe(true);
    expect(c.tokens).toBe(1520 + 2000);
    expect(c.window).toBe(1_000_000);
    expect(c.parts.reduce((a, p) => a + p.tokens, 0)).toBeGreaterThanOrEqual(c.tokens - c.parts.length);
    expect(c.largest).toEqual([{ callId: 'c1', tool: 'read', tokens: part['tool results: read']!.tokens }]);
    const text = formatContext(c);
    expect(text).toContain('context: 3.5k tokens of 1M (0%), hands off at 100k · anthropic/claude-haiku-5-5');
    expect(text).toContain('fixed, sent on every request:');
    expect(text).toContain('tools: mcp github (1)');
    expect(text).toContain('largest tool results: read c1');
    expect(contextBar(c, 10)).toBe('[..........]');
  });

  test('without a reply yet it estimates from characters, and thinking a model never replays is left out', () => {
    const c = contextBreakdown(session().slice(0, 3));
    expect(c.measured).toBe(false);
    expect(c.tokens).toBe(Math.ceil(c.parts.reduce((a, p) => a + p.chars, 0) / 4));
    const deepseek = contextBreakdown([
      ...session(),
      { id: 'x', at: at(50), kind: 'assistant', wire: 'anthropic-messages', model: HAIKU, blocks: [{ type: 'thinking', text: 'T'.repeat(400) }, { type: 'text', text: 'done' }], stop: 'end_turn', usage: usage(4000, 100) } as unknown as SessionEvent,
    ]);
    expect(deepseek.parts.find((p) => p.part === 'thinking')!.chars).toBe(400);
    expect(deepseek.tokens).toBe(4100);
  });
});

const result = (subtype: HeadlessResult['subtype'], text: string, extra: Partial<HeadlessResult> = {}): HeadlessResult =>
  ({ type: 'result', subtype, sessionId: 's1', numTurns: 3, usage: usage(0), costUsd: 0.25, cacheHitRatio: 0, result: text, ...extra }) as HeadlessResult;

// A thread with two runs, each with its result in the writer session's log, and a message from another thread.
function project() {
  const home = mkdtempSync(join(tmpdir(), 'cedia-recap-'));
  const cwd = join(home, 'repo');
  mkdirSync(cwd);
  const store = new ThreadStore(threadsDir(home, 'p'));
  const id = store.open('fix the export button', { now: new Date(at(0)) });
  const sessions = join(home, 'sessions', 'p');
  mkdirSync(sessions, { recursive: true });
  const log = join(sessions, 's1.jsonl');
  store.append(id, { kind: 'session', sessionId: 's1', model: HAIKU, role: 'code', why: 'start', path: log }, new Date(at(1)));
  store.append(id, { kind: 'run', id: 'r1', prompt: 'fix the export button\non Safari', cwd }, new Date(at(2)));
  store.append(id, { kind: 'state', state: 'done', result: 'fixed' }, new Date(at(60)));
  store.append(id, { kind: 'run', id: 'r2', prompt: 'add a test for it', cwd }, new Date(at(300)));
  store.append(id, { kind: 'message', id: 'm1', from: 't-0000beef', text: 'the docs thread needs the new flag name' }, new Date(at(400)));
  store.append(id, { kind: 'todo', items: [{ text: 'write test', state: 'done' }, { text: 'run checks', state: 'doing' }] }, new Date(at(500)));
  store.append(id, { kind: 'state', state: 'done', result: 'added' }, new Date(at(1200)));
  const events = [
    ...session(),
    { kind: 'result', result: result('success', 'Fixed the Safari export: the click handler ran before the blob existed.', { evidence: { changed: ['src/export.ts'], checks: [{ command: 'bun test', exitCode: 1 }], unverified: [] }, timing: { wallMs: 58_000 } as HeadlessResult['timing'] }) },
    { kind: 'result', result: result('success', 'Added test/export.test.ts.\nIt covers Safari.', { evidence: { changed: ['test/export.test.ts', 'src/export.ts'], checks: [{ command: 'bun test', exitCode: 0 }, { command: 'bun run typecheck', exitCode: 0 }], unverified: ['manual Safari check'] }, timing: { wallMs: 890_000 } as HeadlessResult['timing'], subthreads: 2 }) },
  ];
  // Results land at the end of their runs.
  const stamped = events.map((e, i) => ({ id: `e${i}`, at: i === events.length - 2 ? at(59) : i === events.length - 1 ? at(1199) : at(1 + i), ...e }));
  writeFileSync(log, stamped.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { home, cwd, store, id };
}

describe('away recap', () => {
  test('covers the runs since the owner left: how each ended, the files, the last outcome of each check, the cost and what waits', () => {
    const { home, cwd, store, id } = project();
    const t = store.read(id);
    const r = awayRecap(t, new Date(at(120)), { cwd, home });
    expect(r.runs).toEqual([{ at: at(300), prompt: 'add a test for it', subtype: 'success', result: 'Added test/export.test.ts.', costUsd: 0.25, wallMs: 890_000 }]);
    expect(r.changed).toEqual(['src/export.ts', 'test/export.test.ts']);
    expect(r.checks).toEqual([{ command: 'bun test', passed: true }, { command: 'bun run typecheck', passed: true }]);
    expect(r.unverified).toEqual(['manual Safari check']);
    expect([r.costUsd, r.subthreads, r.state, r.running]).toEqual([0.25, 2, 'done', false]);
    expect(r.todo).toEqual({ done: 1, total: 2, doing: 'run checks' });
    expect(r.messages).toEqual([{ from: 't-0000beef', at: at(400), text: 'the docs thread needs the new flag name' }]);
    const text = formatRecap(r, 'while you were away');
    expect(text.split('\n')[0]).toBe('while you were away (18m): 1 run, $0.25, done');
    expect(text).toContain('  > add a test for it  (success in 15m)');
    expect(text).toContain('  checks: ✓ bun test · ✓ bun run typecheck');
    expect(text).toContain('  message from t-0000beef: the docs thread needs the new flag name');

    // From the start, both runs: the first's failed check is overtaken by the second's pass.
    const all = awayRecap(t, new Date(at(0)), { cwd, home });
    expect(all.runs.map((x) => x.prompt)).toEqual(['fix the export button', 'add a test for it']);
    expect(all.costUsd).toBe(0.5);
    expect(all.checks[0]).toEqual({ command: 'bun test', passed: true });
    expect(lastRunStart(t)).toEqual(new Date(at(300)));
  });

  test('a run still going when the owner left counts, and an asking thread shows its question', () => {
    const { home, cwd, store, id } = project();
    store.append(id, { kind: 'run', id: 'r3', prompt: 'ship it', cwd }, new Date(at(1300)));
    store.append(id, { kind: 'question', sessionId: 's1', question: 'Push to main?', options: ['yes', 'no'] }, new Date(at(1400)));
    store.append(id, { kind: 'state', state: 'asking' }, new Date(at(1400)));
    const r = awayRecap(store.read(id), new Date(at(1350)), { cwd, home });
    expect(r.runs).toEqual([{ at: at(1300), prompt: 'ship it' }]);
    expect(r.question).toEqual({ question: 'Push to main?', options: ['yes', 'no'] });
    const text = formatRecap(r);
    expect(text).toContain('waiting for your answer');
    expect(text).toContain('(no result yet)');
    expect(text).toContain('    1. yes');
  });

  test('--since takes a time or a span back from now', () => {
    const now = new Date(at(3600));
    expect(recapSince('30m', now)).toEqual(new Date(at(1800)));
    expect(recapSince('1h', now)).toEqual(new Date(at(0)));
    expect(recapSince(at(5), now)).toEqual(new Date(at(5)));
    expect(() => recapSince('yesterday-ish', now)).toThrow('--since');
    expect([spanText(20_000), spanText(14 * 60_000), spanText(125 * 60_000), spanText(120 * 60_000)]).toEqual(['20s', '14m', '2h 5m', '2h']);
  });

  test('the TUI recaps turns that ended at least AWAY_MS after the owner last showed up', () => {
    expect(presentIn('\x1b[O')).toBe(false);
    expect(presentIn('\x1b[I')).toBe(true);
    expect(presentIn('a')).toBe(true);
    expect(recapWhen(0, AWAY_MS - 1, 'unknown')).toBeUndefined();
    expect(recapWhen(0, AWAY_MS, 'unknown')).toBe('now');
    expect(recapWhen(0, AWAY_MS, 'focused')).toBe('now');
    expect(recapWhen(0, AWAY_MS, 'blurred')).toBe('on-return');
    const { home, cwd, store, id } = project();
    expect(awayText(store, { thread: id, since: Date.parse(at(120)) }, cwd, home)).toStartWith('while you were away (18m): 1 run');
    // Nothing ran in the span: no recap.
    expect(awayText(store, { thread: id, since: Date.parse(at(5000)) }, cwd, home)).toBeUndefined();
  });
});

describe('the commands', () => {
  test('cedia context reads a thread\'s writer session, and cedia threads recap a thread', () => {
    const { home, cwd, store, id } = project();
    const env = { ...process.env, CEDIA_HOME: home, CEDIA_PROJECT: 'p' };
    expect(writerSessionOf(store.read(id), cwd, home)).toEqual({ sessionId: 's1', path: join(home, 'sessions', 'p', 's1.jsonl') });
    const c = Bun.spawnSync([BIN, 'context', '--thread', id, '--json', '--cwd', cwd], { env });
    expect(c.stderr.toString()).toBe('');
    expect(JSON.parse(c.stdout.toString())).toMatchObject({ sessionId: 's1', model: HAIKU, measured: true, window: 1_000_000 });
    // With no thread named: the newest one.
    const text = Bun.spawnSync([BIN, 'context', '--cwd', cwd], { env });
    expect(text.stdout.toString()).toContain('tools: mcp github (1)');
    const r = Bun.spawnSync([BIN, 'threads', 'recap', id, '--json', '--cwd', cwd], { env });
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ thread: id, since: at(300), costUsd: 0.25 });
    const since = Bun.spawnSync([BIN, 'threads', 'recap', id, '--since', at(0), '--cwd', cwd], { env });
    expect(since.stdout.toString()).toContain('recap (20m): 2 runs, $0.50, done');
  });
});
