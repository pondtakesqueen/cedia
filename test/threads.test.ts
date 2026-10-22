import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrompt } from '../src/core/loop/run.ts';
import { HANDOFF_NO_TOOLS, HANDOFF_PROMPT, defaultHandoffAt } from '../src/core/project/handoff.ts';
import { foldThread, threadsDir, ThreadStore, titleOf } from '../src/core/project/threads.ts';
import { resolveModel } from '../src/core/providers/catalog.ts';
import { fauxProvider, type FauxStep } from '../src/core/providers/faux.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { projectKey, projectRoot, projectSlug, SessionLog } from '../src/core/session/log.ts';
import { CORE_TOOLS } from '../src/core/tools/index.ts';
import { spawnNudge, spawnTool } from '../src/core/tools/spawn.ts';
import { recallTool, threadTools } from '../src/core/tools/threads.ts';
import type { EventOf, SessionEvent } from '../src/core/types.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'cedia-threads-'));
const reply = (text: string) => ({ blocks: [{ type: 'text' as const, text }] });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ blocks: [{ type: 'tool_use' as const, id, name, input }] });
const call = (id: string, command: string) => tool(id, 'bash', { command });
const ctx = { cwd: '/', signal: new AbortController().signal };

describe('thread store', () => {
  test('folds sessions, the latest handoff, messages not yet delivered, and the state', () => {
    const store = new ThreadStore(join(tmp(), 'threads'));
    const id = store.open('Fix the login bug\nmore detail');
    expect(id).toMatch(/^t-[0-9a-f]{8}$/);
    store.append(id, { kind: 'session', sessionId: 's1', model: 'm', role: 'code', why: 'start' });
    store.append(id, { kind: 'handoff', sessionId: 's1', note: 'first note' });
    store.append(id, { kind: 'session', sessionId: 's2', model: 'm', role: 'code', why: 'handoff' });
    const a = store.send(id, 'user', 'hello');
    const b = store.send(id, 't-00000000', 'from another');
    store.append(id, { kind: 'delivered', ids: [a], sessionId: 's2' });
    store.append(id, { kind: 'state', state: 'done', result: 'fixed' });
    const t = store.read(id);
    expect(t).toMatchObject({ title: 'Fix the login bug', task: 'Fix the login bug\nmore detail', state: 'done', result: 'fixed', handoff: { sessionId: 's1', note: 'first note' } });
    expect(t.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(t.messages.map((m) => m.id)).toEqual([a, b]);
    expect(t.pending.map((m) => m.id)).toEqual([b]);
    expect(store.list().map((x) => x.id)).toEqual([id]);
  });

  test('refuses an unknown thread and anything that is not a thread id', () => {
    const store = new ThreadStore(join(tmp(), 'threads'));
    expect(() => store.send('t-12345678', 'user', 'x')).toThrow('no thread t-12345678');
    expect(() => store.read('../../etc/passwd')).toThrow('not a thread id');
    expect(store.has('../x')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test('unsend takes back the user\'s waiting messages; one a session was shown stays delivered in either order', () => {
    const store = new ThreadStore(join(tmp(), 'threads'));
    const id = store.open('task');
    store.append(id, { kind: 'session', sessionId: 's1', model: 'm', role: 'code', why: 'start' });
    const a = store.send(id, 'user', 'first');
    const b = store.send(id, 'user', 'second');
    const c = store.send(id, 't-00000000', 'from another thread');
    expect(store.unsend(id, [a])).toEqual([a]);
    expect(store.read(id).pending.map((m) => m.id)).toEqual([b, c]);
    expect(store.read(id).messages.find((m) => m.id === a)?.unsent).toBe(true);
    expect(() => store.unsend(id, [a])).toThrow('already unsent');
    expect(() => store.unsend(id, [c])).toThrow('not the user');
    expect(() => store.unsend(id, ['nope'])).toThrow('no message nope');
    store.append(id, { kind: 'delivered', ids: [b], sessionId: 's1' });
    expect(() => store.unsend(id, [b])).toThrow('already delivered');
    // With no ids: every user message still waiting, which is none now.
    expect(store.unsend(id)).toEqual([]);
    // A session picked the message up before the unsend line landed: it was seen, so it counts as delivered.
    const d = store.send(id, 'user', 'raced');
    store.append(id, { kind: 'delivered', ids: [d], sessionId: 's1' });
    store.append(id, { kind: 'unsend', ids: [d] });
    expect(store.read(id).messages.find((m) => m.id === d)?.unsent).toBeUndefined();
  });

  test('rate records a thumbs up or down on the latest answer, or on a named session', () => {
    const store = new ThreadStore(join(tmp(), 'threads'));
    const id = store.open('task');
    store.append(id, { kind: 'session', sessionId: 's1', model: 'm', role: 'code', why: 'start' });
    store.append(id, { kind: 'session', sessionId: 's2', model: 'm', role: 'code', why: 'resume' });
    store.rate(id, 'up');
    store.rate(id, 'down', { sessionId: 's1', note: 'missed the edge case' });
    expect(store.read(id).ratings.map(({ at: _, ...r }) => r)).toEqual([
      { rating: 'up', sessionId: 's2' },
      { rating: 'down', sessionId: 's1', note: 'missed the edge case' },
    ]);
    expect(() => store.rate(id, 'meh' as 'up')).toThrow('a rating is up or down');
    expect(() => store.rate(id, 'up', { sessionId: 's9' })).toThrow('no session s9');
  });

  test('titles are the first line, cut at 60 characters', () => {
    expect(titleOf('  short task  \nsecond')).toBe('short task');
    expect(titleOf('x'.repeat(80))).toBe('x'.repeat(57) + '...');
    expect(foldThread('t-00000000', []).state).toBe('working');
  });
});

describe('recall', () => {
  const log = SessionLog.create();
  log.append({ kind: 'session', cwd: '/', role: 'code', model: 'm', system: '', tools: [] });
  log.append({ kind: 'user', text: 'fix the parser' });
  log.append({ kind: 'assistant', wire: 'faux', model: 'm', blocks: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'bun test' } }], stop: 'tool_use', usage: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
  log.append({ kind: 'tool_result', callId: 'c1', status: 'failed', output: { text: 'error: TypeError at parse.ts:42 unexpected token', isError: true } });
  const recall = recallTool(() => [{ id: log.id, events: () => log.events }]);

  test('finds text in tool results and calls, with where it came from', async () => {
    const r = await recall.run({ query: 'parse\\.ts:\\d+' }, ctx);
    expect(r.text).toContain('1 match');
    expect(r.text).toContain('[session 1 of 1 · result bash] error: TypeError at parse.ts:42');
    expect((await recall.run({ query: 'bun test' }, ctx)).text).toContain('call bash');
  });

  test('a query that is not a valid regex is searched as text; no match says so', async () => {
    expect((await recall.run({ query: 'TypeError at (' }, ctx)).text).toContain('no match');
    expect((await recall.run({ query: 'unexpected token' }, ctx)).isError).toBe(false);
    expect((await recall.run({ query: '' }, ctx)).isError).toBe(true);
  });
});

describe('thread tools', () => {
  test('list and read other threads, and message one; never this one', async () => {
    const store = new ThreadStore(join(tmp(), 'threads'));
    const me = store.open('my task');
    const other = store.open('the API task');
    store.append(other, { kind: 'handoff', sessionId: 's9', note: 'endpoints done, auth left' });
    const [list, read, send] = threadTools(store, me);
    const listed = (await list!.run({}, ctx)).text;
    expect(listed).toContain(other);
    expect(listed).toContain('endpoints done, auth left');
    expect(listed).not.toContain(me);
    expect((await read!.run({ id: other }, ctx)).text).toContain('<handoff session="s9">\nendpoints done, auth left\n</handoff>');
    expect((await send!.run({ id: other, text: 'auth uses the session cookie' }, ctx)).text).toBe(`sent to ${other}`);
    expect(store.read(other).pending).toMatchObject([{ from: me, text: 'auth uses the session cookie' }]);
    expect((await send!.run({ id: me, text: 'x' }, ctx)).isError).toBe(true);
    expect((await read!.run({ id: 't-99999999' }, ctx)).isError).toBe(true);
    // Sending changes state outside the session, so read-only sessions may not.
    expect(send!.effect).toBe('write_workspace');
  });
});

describe('handoff in the loop', () => {
  const model = resolveModel('faux');
  const big = 'x'.repeat(40_000);
  const bigTool = { ...CORE_TOOLS[0]!, name: 'big', effect: 'read' as const, pathOf: undefined, run: async () => ({ text: big, isError: false }) };
  const run = (script: FauxStep[], extra: Partial<Parameters<typeof runPrompt>[0]> = {}) => {
    const log = SessionLog.create();
    const permission = { mode: 'workspace' as const, allow: [], deny: [] };
    return runPrompt({ log, provider: fauxProvider(script), model, tools: [...CORE_TOOLS, bigTool], system: 'sys', cwd: tmp(), permission, ...extra }, 'do it').then((r) => ({ r, log }));
  };

  const write = tool('w1', 'write', { path: 'f.txt', content: 'x' });

  test('once the context passes handoffAt, the session writes its note and ends with subtype handoff', async () => {
    const { r, log } = await run([write, tool('c1', 'big', {}), reply('NOTE: next, run the tests')], { handoffAt: 2000 });
    expect(r.subtype).toBe('handoff');
    expect(r.result).toBe('NOTE: next, run the tests');
    expect(log.events.some((e) => e.kind === 'reminder' && e.text === HANDOFF_PROMPT)).toBe(true);
    expect(log.events.at(-1)).toMatchObject({ kind: 'turn_end', reason: 'handoff' });
    expect(lintSession(log.events)).toEqual([]);
  });

  test('below handoffAt, or without it, nothing changes', async () => {
    for (const extra of [{}, { handoffAt: 1_000_000 }]) {
      const { r, log } = await run([tool('c1', 'big', {}), reply('done')], extra);
      expect(r.subtype).toBe('success');
      expect(log.events.some((e) => e.kind === 'reminder' && e.text === HANDOFF_PROMPT)).toBe(false);
    }
  });

  test('a tool call instead of the note is not run; a second one gives up the handoff and the session goes on', async () => {
    const once = await run([write, tool('c1', 'big', {}), call('c2', 'ls'), reply('the note')], { handoffAt: 2000 });
    expect(once.r).toMatchObject({ subtype: 'handoff', result: 'the note' });
    expect(once.log.events.find((e): e is EventOf<'tool_result'> => e.kind === 'tool_result' && e.callId === 'c2')).toMatchObject({ status: 'not_started', output: { text: HANDOFF_NO_TOOLS } });

    const never = await run([write, tool('c1', 'big', {}), call('c2', 'ls'), call('c3', 'ls'), reply('done anyway')], { handoffAt: 2000 });
    expect(never.r).toMatchObject({ subtype: 'success', result: 'done anyway' });
    expect(lintSession(never.log.events)).toEqual([]);
  });

  test('a first session that has only read hands off; one that picked up from another must change a file first', async () => {
    const first = await run([tool('c1', 'big', {}), reply('the plan')], { handoffAt: 2000 });
    expect(first.r).toMatchObject({ subtype: 'handoff', result: 'the plan' });
    const continues = { sessionId: 'earlier', changed: [] };
    const { r, log } = await run([tool('c1', 'big', {}), tool('c2', 'big', {}), write, tool('c3', 'big', {}), reply('the note')], { handoffAt: 2000, continues });
    expect(r).toMatchObject({ subtype: 'handoff', result: 'the note' });
    // Asked for the note only after the write, two turns past the point it first passed handoffAt.
    const asked = log.events.findIndex((e) => e.kind === 'reminder' && e.text === HANDOFF_PROMPT);
    const wrote = log.events.findIndex((e) => e.kind === 'tool_result' && e.callId === 'w1');
    expect(asked).toBeGreaterThan(wrote);
  });

  test('a session that starts large does not hand off until its context doubles', async () => {
    const { r } = await run([call('c1', 'ls'), reply('done')], { handoffAt: 1000, system: big });
    expect(r.subtype).toBe('success');
  });

  test('messages are logged as a reminder at a turn boundary, then marked delivered', async () => {
    const delivered: string[][] = [];
    let mail: { ids: string[]; text: string } | undefined = { ids: ['m1'], text: '<message from="t-1">use port 8080</message>' };
    const inbox = {
      pending: () => mail,
      delivered: (ids: string[]) => {
        delivered.push(ids);
        mail = undefined;
      },
    };
    const { log } = await run([call('c1', 'ls'), reply('done')], { inbox });
    const reminders = log.events.filter((e): e is EventOf<'reminder'> => e.kind === 'reminder');
    expect(reminders.map((e) => e.text)).toEqual(['<message from="t-1">use port 8080</message>']);
    expect(delivered).toEqual([['m1']]);
  });

  const spawner = spawnTool(async () => ({ model: 'faux/scripted', subtype: 'success', result: 'found it', costUsd: 0, changed: [], unverified: [] }));
  const nudges = (log: SessionLog) => log.events.filter((e) => e.kind === 'reminder' && e.text.endsWith(spawnNudge(0).split('tokens')[1]!));

  test('past spawnNudgeAt, a session with the spawn tool is reminded of it once', async () => {
    const { r, log } = await run([tool('c1', 'big', {}), tool('c2', 'big', {}), reply('done')], { spawnNudgeAt: 2000, tools: [...CORE_TOOLS, spawner, bigTool] });
    expect(r.subtype).toBe('success');
    expect(nudges(log)).toHaveLength(1);
    expect(nudges(log)[0]).toMatchObject({ text: expect.stringMatching(/^Your context is about 1\dk tokens/) });
    expect(lintSession(log.events)).toEqual([]);
  });

  test('no spawn reminder without the tool, below the mark, or once the session has spawned', async () => {
    const without = await run([tool('c1', 'big', {}), reply('done')], { spawnNudgeAt: 2000 });
    expect(nudges(without.log)).toHaveLength(0);
    const below = await run([tool('c1', 'big', {}), reply('done')], { spawnNudgeAt: 1_000_000, tools: [...CORE_TOOLS, spawner, bigTool] });
    expect(nudges(below.log)).toHaveLength(0);
    const spawned = await run([tool('s1', 'spawn', { kind: 'explore', task: 'find it' }), tool('c1', 'big', {}), reply('done')], { spawnNudgeAt: 2000, tools: [...CORE_TOOLS, spawner, bigTool] });
    expect(nudges(spawned.log)).toHaveLength(0);
  });

  test('the handoff note request wins over the spawn reminder in the same turn', async () => {
    const { r, log } = await run([write, tool('c1', 'big', {}), reply('the note')], { handoffAt: 2000, spawnNudgeAt: 2000, tools: [...CORE_TOOLS, spawner, bigTool] });
    expect(r.subtype).toBe('handoff');
    expect(nudges(log)).toHaveLength(0);
  });

  test('the default handoff point is half the window, at most 150k, and below a long-context price', () => {
    expect(defaultHandoffAt(resolveModel('faux'))).toBeLessThanOrEqual(150_000);
    const m = resolveModel('faux');
    expect(defaultHandoffAt({ ...m, caps: { ...m.caps, contextWindow: 128_000 } })).toBe(64_000);
    expect(defaultHandoffAt({ ...m, caps: { ...m.caps, contextWindow: 1_000_000 }, price: { ...m.price, above: { tokens: 100_000, price: m.price } } })).toBe(90_000);
  });
});

// End to end through bin/cedia with the faux provider: sessions, the thread file, and the CLI.
const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
function cedia(dir: string, script: unknown[], args: string[]) {
  const scriptPath = join(dir, `script-${crypto.randomUUID()}.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
  const proc = Bun.spawnSync([BIN, '-m', 'faux', '--cwd', dir, ...args], {
    env: { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: join(dir, 'home') },
    stdin: 'ignore',
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}
const threadsCli = (dir: string, ...args: string[]) => {
  const proc = Bun.spawnSync([BIN, 'threads', ...args, '--cwd', dir], { env: { ...process.env, CEDIA_HOME: join(dir, 'home') } });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
};
const sessionsOf = (dir: string) => {
  const root = join(dir, 'home', 'sessions', projectSlug(dir));
  return readdirSync(root).map((f) => SessionLog.load(join(root, f)));
};
const head = (events: SessionEvent[]) => events[0] as EventOf<'session'>;
const userText = (events: SessionEvent[]) => events.filter((e): e is EventOf<'reminder' | 'user'> => e.kind === 'reminder' || e.kind === 'user').map((e) => e.text).join('\n');
const storeOf = (dir: string) => new ThreadStore(threadsDir(join(dir, 'home'), projectSlug(dir)));

describe('cedia threads (offline, faux)', () => {
  const base = ['--output-format', 'json', '--permission', 'workspace', '--sandbox', 'off', '--check', 'grep -q good f.txt'];

  test('a long session hands off: the new session starts from the task and the note, can recall, and must still verify', () => {
    const dir = tmp();
    const r = cedia(dir, [call('c1', 'echo good > f.txt && seq 1 6000'), reply('Wrote f.txt. Next: run the check.'), call('c2', 'grep -q good f.txt'), reply('done')], ['-p', 'make f.txt say good', ...base, '--handoff-at', '2000']);
    const result = JSON.parse(r.out);
    expect(result).toMatchObject({ subtype: 'success', numTurns: 4, evidence: { changed: ['f.txt'], unverified: [] } });
    expect(result.sessions).toHaveLength(2);
    expect(r.err).toContain('handing off to a new session');
    const [first, second] = result.sessions.map((id: string) => sessionsOf(dir).find((l) => l.id === id)!);
    expect(head(second.events)).toMatchObject({ parentSession: first.id, thread: result.thread });
    expect(userText(second.events)).toContain(`<handoff session="${first.id}">\nWrote f.txt. Next: run the check.\n</handoff>`);
    expect(userText(second.events)).toContain('make f.txt say good');
    expect(head(second.events).tools.map((t) => t.name)).toContain('recall');
    expect(head(first.events).tools.map((t) => t.name)).not.toContain('recall');
    for (const l of [first, second]) expect(lintSession(l.events)).toEqual([]);
    const t = storeOf(dir).read(result.thread);
    expect(t).toMatchObject({ state: 'done', result: 'done', handoff: { sessionId: first.id } });
    expect(t.sessions.map((s) => s.why)).toEqual(['start', 'handoff']);

    // The handed-off session's claim still needs a check after the first session's write.
    const lazy = cedia(tmp(), [call('c1', 'echo good > f.txt && seq 1 6000'), reply('note'), reply('done'), reply('done')], ['-p', 'make f.txt say good', ...base, '--handoff-at', '2000']);
    expect(JSON.parse(lazy.out)).toMatchObject({ subtype: 'error_unverified_claim', evidence: { unverified: ['f.txt'] } });
  });

  test('--thread goes on in the same session on the same model, or in a new one that starts from where it stopped', () => {
    const dir = tmp();
    const first = JSON.parse(cedia(dir, [call('c1', 'echo good > f.txt'), call('c2', 'grep -q good f.txt'), reply('first done')], ['-p', 'make f.txt say good', ...base]).out);
    const again = JSON.parse(cedia(dir, [call('c3', 'grep -q good f.txt'), reply('second done')], ['-p', 'check it again', ...base, '--thread', first.thread]).out);
    expect(again).toMatchObject({ subtype: 'success', thread: first.thread, sessionId: first.sessionId });
    const log = sessionsOf(dir).find((l) => l.id === first.sessionId)!;
    expect(log.events.filter((e) => e.kind === 'user').map((e) => (e as EventOf<'user'>).text)).toEqual(['make f.txt say good', 'check it again']);
    expect(lintSession(log.events)).toEqual([]);

    const other = JSON.parse(cedia(dir, [call('c4', 'grep -q good f.txt'), reply('third done')], ['-p', 'once more', ...base, '--thread', first.thread, '-m', 'faux/fallback']).out);
    expect(other.sessionId).not.toBe(first.sessionId);
    const fresh = sessionsOf(dir).find((l) => l.id === other.sessionId)!;
    expect(userText(fresh.events)).toContain(`This is thread ${first.thread}`);
    expect(userText(fresh.events)).toContain('<result session=');
    expect(head(fresh.events).tools.map((t) => t.name)).toContain('recall');
    expect(storeOf(dir).read(first.thread).sessions.map((s) => s.why)).toEqual(['start', 'resume', 'resume']);

    expect(cedia(dir, [], ['-p', 'x', ...base, '--thread', 't-00000000']).err).toContain('no thread t-00000000 in this project');
  });

  test('the run\'s result is logged after the writer\'s last turn_end, never streamed twice or shown to a model', () => {
    const dir = tmp();
    const first = JSON.parse(cedia(dir, [call('c1', 'echo good > f.txt'), call('c2', 'grep -q good f.txt'), reply('first done')], ['-p', 'make f.txt say good', ...base]).out);
    const logged = () => sessionsOf(dir).find((l) => l.id === first.sessionId)!.events;
    expect(logged().at(-1)).toMatchObject({ kind: 'result', result: first });
    expect(lintSession(logged())).toEqual([]);
    // Resumed in the same session: the result sits between two runs, and the model's requests do not change.
    const again = cedia(dir, [call('c3', 'grep -q good f.txt'), reply('second done')], ['-p', 'check it again', ...base, '--thread', first.thread, '--output-format', 'stream-json']);
    const lines = again.out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.type === 'event' && l.event.kind === 'result')).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ type: 'result', result: 'second done' });
    const events = logged();
    expect(events.filter((e) => e.kind === 'result').map((e) => (e as EventOf<'result'>).result.result)).toEqual(['first done', 'second done']);
    expect(lintSession(events)).toEqual([]);
    const requests = events.filter((e): e is EventOf<'request'> => e.kind === 'request');
    expect(new Set(requests.map((r) => r.systemHash)).size).toBe(1);
    expect(userText(events)).not.toContain('first done');
  });

  test('threads talk: one messages another, the user sends one, and both arrive when it resumes', () => {
    const dir = tmp();
    const a = JSON.parse(cedia(dir, [reply('A done')], ['-p', 'build the API', ...base, '--check', 'true']).out);
    // B sees the thread tools because A exists; it lists, reads, and messages A.
    const b = JSON.parse(
      cedia(dir, [tool('c1', 'threads', {}), tool('c2', 'read_thread', { id: a.thread }), tool('c3', 'message_thread', { id: a.thread, text: 'the client needs a /health route' }), reply('B done')], ['-p', 'build the client', ...base, '--check', 'true']).out,
    );
    expect(b.subtype).toBe('success');
    const bLog = sessionsOf(dir).find((l) => l.id === b.sessionId)!;
    const results = bLog.events.filter((e): e is EventOf<'tool_result'> => e.kind === 'tool_result');
    expect(results[0]!.output.text).toContain(a.thread);
    expect(results[1]!.output.text).toContain('<task>\nbuild the API\n</task>');
    expect(threadsCli(dir, 'send', a.thread, 'also log every request').out).toContain(`sent to ${a.thread}`);
    expect(threadsCli(dir, 'show', a.thread).out).toContain('(not seen yet)');

    const resumed = JSON.parse(cedia(dir, [reply('added /health')], ['-p', 'check your messages', ...base, '--check', 'true', '--thread', a.thread]).out);
    expect(resumed.subtype).toBe('success');
    const aLog = sessionsOf(dir).find((l) => l.id === a.sessionId)!;
    const mail = aLog.events.filter((e): e is EventOf<'reminder'> => e.kind === 'reminder').at(-1)!.text;
    expect(mail).toContain(`<message from="${b.thread}"`);
    expect(mail).toContain('the client needs a /health route');
    expect(mail).toContain('<message from="user"');
    expect(storeOf(dir).read(a.thread).pending).toEqual([]);
    expect(lintSession(aLog.events)).toEqual([]);

    const listed = threadsCli(dir).out;
    expect(listed).toContain(a.thread);
    expect(listed).toContain(b.thread);
    expect(threadsCli(dir, 'show', 'nope').code).toBe(1);
  });

  test('unsend and rate from the CLI: an unsent message never reaches the model, and neither does a rating', () => {
    const dir = tmp();
    const a = JSON.parse(cedia(dir, [reply('A done')], ['-p', 'build the API', ...base, '--check', 'true']).out);
    const kept = /as (\S+)/.exec(threadsCli(dir, 'send', a.thread, 'keep this one').out)![1]!;
    const taken = /as (\S+)/.exec(threadsCli(dir, 'send', a.thread, 'take this back').out)![1]!;
    expect(threadsCli(dir, 'unsend', a.thread, taken).out).toContain(`unsent ${taken} from ${a.thread}`);
    expect(threadsCli(dir, 'unsend', a.thread, taken).code).toBe(1);
    expect(threadsCli(dir, 'rate', a.thread, 'down', '--note', 'too slow').out).toContain(`rated ${a.thread} down`);
    expect(threadsCli(dir, 'rate', a.thread, 'sideways').code).toBe(1);
    const shown = threadsCli(dir, 'show', a.thread).out;
    expect(shown).toContain(`message ${taken} from user`);
    expect(shown).toContain('(unsent)');
    expect(shown).toContain(`rated down`);
    expect(shown).toContain('too slow');

    // B reads A with read_thread, then A resumes: neither sees the unsent message or the rating.
    const b = JSON.parse(cedia(dir, [tool('c1', 'read_thread', { id: a.thread }), reply('B done')], ['-p', 'build the client', ...base, '--check', 'true']).out);
    const resumed = JSON.parse(cedia(dir, [reply('ok')], ['-p', 'go on', ...base, '--check', 'true', '--thread', a.thread]).out);
    expect(resumed.subtype).toBe('success');
    for (const id of [b.sessionId, a.sessionId]) {
      const seen = JSON.stringify(sessionsOf(dir).find((l) => l.id === id)!.events);
      expect(seen).not.toContain('take this back');
      expect(seen).not.toContain('too slow');
    }
    expect(JSON.stringify(sessionsOf(dir).find((l) => l.id === a.sessionId)!.events)).toContain('keep this one');
    expect(storeOf(dir).read(a.thread).pending).toEqual([]);
    expect(storeOf(dir).read(a.thread).messages.map((m) => m.id)).toEqual([kept, taken]);
  });

  test('a read-only session cannot message another thread', () => {
    const dir = tmp();
    const a = JSON.parse(cedia(dir, [reply('A done')], ['-p', 'first', '--output-format', 'json', '--sandbox', 'off']).out);
    const b = JSON.parse(cedia(dir, [tool('c1', 'message_thread', { id: a.thread, text: 'hi' }), reply('B done')], ['-p', 'second', '--output-format', 'json', '--sandbox', 'off']).out);
    const bLog = sessionsOf(dir).find((l) => l.id === b.sessionId)!;
    expect(bLog.events.find((e) => e.kind === 'tool_result')).toMatchObject({ status: 'denied' });
    expect(storeOf(dir).read(a.thread).messages).toEqual([]);
  });

  test('--handoff-at rejects nonsense', () => {
    expect(cedia(tmp(), [], ['-p', 'x', '--handoff-at', '12']).err).toContain('handoff-at must be a token count of at least 1000');
  });
});

describe('sub-threads (offline, faux)', () => {
  const ws = ['--output-format', 'json', '--permission', 'workspace', '--sandbox', 'off', '--check', 'grep -q good f.txt'];

  test('a work sub-thread writes in its own session; only its report comes back, and the parent must still check', () => {
    const dir = tmp();
    const script = [
      tool('s1', 'spawn', { kind: 'work', task: 'Write good to f.txt, then run grep -q good f.txt.' }),
      call('c1', 'echo good > f.txt'),
      call('c2', 'grep -q good f.txt'),
      reply('Wrote good to f.txt; grep -q good f.txt passes.'),
      reply('done'),
      call('c3', 'grep -q good f.txt'),
      reply('done, checked'),
    ];
    const result = JSON.parse(cedia(dir, script, ['-p', 'make f.txt say good', ...ws]).out);
    expect(result).toMatchObject({ subtype: 'success', result: 'done, checked', evidence: { unverified: [] } });
    expect(result.evidence.changed).toContain('f.txt');
    const parent = sessionsOf(dir).find((l) => l.id === result.sessionId)!;
    expect(head(parent.events).tools.map((t) => t.name)).toContain('spawn');
    const report = parent.events.find((e): e is EventOf<'tool_result'> => e.kind === 'tool_result' && e.callId === 's1')!.output.text;
    expect(report).toContain('Wrote good to f.txt; grep -q good f.txt passes.');
    expect(report).toContain('kind="work"');
    expect(report).toContain('Changed: f.txt');
    // The child's own calls never enter the parent's context.
    expect(JSON.stringify(parent.events)).not.toContain('echo good > f.txt');
    // The parent's claim right after the spawn was refused once: the sub-thread's write needed a check.
    expect(parent.events.some((e) => e.kind === 'reminder' && e.text.includes('no record of a declared check passing'))).toBe(true);

    const store = storeOf(dir);
    const sub = store.list().find((t) => t.parent === result.thread)!;
    expect(sub).toMatchObject({ state: 'done', archived: true, title: 'Write good to f.txt, then run grep -q good f.txt.' });
    // The result pools both threads' checks, each named by the thread that ran it.
    expect(result.evidence.checks).toEqual([
      { command: 'grep -q good f.txt', exitCode: 0, thread: sub.id },
      { command: 'grep -q good f.txt', exitCode: 0, thread: result.thread },
    ]);
    const child = sessionsOf(dir).find((l) => l.id === sub.sessions[0]!.sessionId)!;
    expect(head(child.events)).toMatchObject({ thread: sub.id });
    expect(head(child.events).tools.map((t) => t.name)).toEqual(['read', 'edit', 'write', 'bash']);
    for (const l of [parent, child]) expect(lintSession(l.events)).toEqual([]);
    expect(threadsCli(dir).out).not.toContain(sub.id);
    expect(threadsCli(dir, '--all').out).toContain(`(sub-thread of ${result.thread}) (archived)`);
  });

  test('a long work sub-thread hands off to a new session of the sub-thread, which can recall and must still verify', () => {
    const dir = tmp();
    const script = [
      tool('s1', 'spawn', { kind: 'work', task: 'Write good to f.txt, then run grep -q good f.txt.' }),
      call('c1', 'echo good > f.txt && seq 1 6000'),
      reply('Wrote f.txt. Next: run grep -q good f.txt.'),
      call('c2', 'grep -q good f.txt'),
      reply('Wrote good to f.txt; grep -q good f.txt passes.'),
      call('c3', 'grep -q good f.txt'),
      reply('done, checked'),
    ];
    const run = cedia(dir, script, ['-p', 'make f.txt say good', ...ws, '--handoff-at', '2000']);
    const result = JSON.parse(run.out);
    expect(result).toMatchObject({ subtype: 'success', result: 'done, checked', evidence: { unverified: [] } });
    expect(run.err).toContain("a sub-thread's context reached 2000 tokens; handing it off to a new session");
    // The parent itself did not hand off: one writer session.
    expect(result.sessions).toHaveLength(1);
    // The result counts the sub-thread's handoff, and keeps its context apart from the parent's.
    expect(result.spawned).toMatchObject({ explore: 0, work: 1, handoffs: 1 });
    expect(result.spawned.peakContext).toBeGreaterThan(2000);
    expect(result.peakContext).toBeLessThan(result.spawned.peakContext);
    const parent = sessionsOf(dir).find((l) => l.id === result.sessionId)!;
    const report = parent.events.find((e): e is EventOf<'tool_result'> => e.kind === 'tool_result' && e.callId === 's1')!;
    expect(report).toMatchObject({ status: 'completed' });
    expect(report.output.text).toContain('Wrote good to f.txt; grep -q good f.txt passes.');
    expect(report.output.text).toContain('Changed: f.txt');
    expect(report.output.text).not.toContain('Wrote f.txt. Next:');

    const sub = storeOf(dir).list().find((t) => t.parent === result.thread)!;
    expect(sub).toMatchObject({ state: 'done', archived: true });
    expect(sub.sessions.map((s) => [s.role, s.why])).toEqual([['code', 'start'], ['code', 'handoff']]);
    const [first, second] = sub.sessions.map((s) => sessionsOf(dir).find((l) => l.id === s.sessionId)!);
    expect(sub.handoff).toEqual({ sessionId: first!.id, note: 'Wrote f.txt. Next: run grep -q good f.txt.' });
    expect(head(second!.events)).toMatchObject({ thread: sub.id, parentSession: first!.id });
    expect(userText(second!.events)).toContain(`<handoff session="${first!.id}">\nWrote f.txt. Next: run grep -q good f.txt.\n</handoff>`);
    expect(userText(second!.events)).toContain('Write good to f.txt, then run grep -q good f.txt.');
    expect(head(first!.events).tools.map((t) => t.name)).toEqual(['read', 'edit', 'write', 'bash']);
    expect(head(second!.events).tools.map((t) => t.name)).toEqual(['read', 'edit', 'write', 'bash', 'recall']);
    for (const l of [parent, first!, second!]) expect(lintSession(l.events)).toEqual([]);

    // The new session inherits the first one's write, so its claim still needs a check after it.
    const lazyDir = tmp();
    const lazy = cedia(lazyDir, [script[0], script[1], script[2], reply('done'), reply('done'), call('c3', 'grep -q good f.txt'), reply('fixed it myself')], ['-p', 'make f.txt say good', ...ws, '--handoff-at', '2000']);
    const lazyResult = JSON.parse(lazy.out);
    expect(lazyResult.subtype).toBe('success');
    const lazyParent = sessionsOf(lazyDir).find((l) => l.id === lazyResult.sessionId)!;
    expect(lazyParent.events.find((e) => e.kind === 'tool_result')).toMatchObject({ status: 'failed' });
    expect(lazyParent.events.find((e) => e.kind === 'tool_result')!.output.text).toContain('ended="error_unverified_claim"');
  });

  test('explore runs read-only on the swarm model, even from a read-only session; work is refused there', () => {
    const dir = tmp();
    const ro = ['--output-format', 'json', '--sandbox', 'off', '--swarm', 'faux/fallback'];
    const script = [
      tool('s1', 'spawn', { kind: 'explore', task: 'Find where the port is set.' }),
      call('c1', 'echo 1 > g.txt'),
      reply('Port is set in server.ts:3.'),
      tool('s2', 'spawn', { kind: 'work', task: 'Change the port.' }),
      reply('found it'),
    ];
    const result = JSON.parse(cedia(dir, script, ['-p', 'where is the port set?', ...ro]).out);
    expect(result).toMatchObject({ subtype: 'success', result: 'found it' });
    const parent = sessionsOf(dir).find((l) => l.id === result.sessionId)!;
    const results = parent.events.filter((e): e is EventOf<'tool_result'> => e.kind === 'tool_result');
    expect(results[0]!.output.text).toContain('Port is set in server.ts:3.');
    expect(results[0]!.output.text).toContain('model="faux/fallback"');
    expect(results[1]).toMatchObject({ status: 'denied' });
    const sub = storeOf(dir).list().find((t) => t.parent === result.thread)!;
    const child = sessionsOf(dir).find((l) => l.id === sub.sessions[0]!.sessionId)!;
    expect(head(child.events)).toMatchObject({ model: 'faux/fallback', role: 'explore' });
    expect(child.events.find((e) => e.kind === 'tool_result')).toMatchObject({ status: 'denied' });
  });

  test('an explore sub-thread whose swarm model is out of quota goes on on the writer model', () => {
    const dir = tmp();
    const ro = ['--output-format', 'json', '--sandbox', 'off', '--swarm', 'faux/fallback'];
    const script = [
      tool('s1', 'spawn', { kind: 'explore', task: 'Find where the port is set.' }),
      { error: { code: 'quota', status: 429, message: 'Rate limit exceeded' } },
      reply('Port is set in server.ts:3.'),
      reply('found it'),
    ];
    const run = cedia(dir, script, ['-p', 'where is the port set?', ...ro]);
    const result = JSON.parse(run.out);
    expect(result).toMatchObject({ subtype: 'success', result: 'found it' });
    expect(run.err).toContain('faux/fallback is out of quota; the explore sub-thread goes on on faux/scripted');
    const parent = sessionsOf(dir).find((l) => l.id === result.sessionId)!;
    const report = parent.events.find((e): e is EventOf<'tool_result'> => e.kind === 'tool_result')!;
    expect(report).toMatchObject({ status: 'completed' });
    expect(report.output.text).toContain('model="faux/scripted"');
    expect(report.output.text).toContain('Port is set in server.ts:3.');
    const sub = storeOf(dir).list().find((t) => t.parent === result.thread)!;
    expect(sub.sessions.map((s) => [s.model, s.why])).toEqual([['faux/fallback', 'start'], ['faux/scripted', 'quota']]);
  });

  test('a sub-thread that fails stays listed, and the parent sees the failure', () => {
    const dir = tmp();
    const script = [tool('s1', 'spawn', { kind: 'work', task: 'Write good to f.txt.' }), call('c1', 'echo good > f.txt'), reply('done'), reply('done'), call('c2', 'grep -q good f.txt'), reply('fixed it myself')];
    const result = JSON.parse(cedia(dir, script, ['-p', 'make f.txt say good', ...ws]).out);
    expect(result.subtype).toBe('success');
    const parent = sessionsOf(dir).find((l) => l.id === result.sessionId)!;
    expect(parent.events.find((e) => e.kind === 'tool_result')).toMatchObject({ status: 'failed', output: { isError: true } });
    const sub = storeOf(dir).list().find((t) => t.parent === result.thread)!;
    expect(sub).toMatchObject({ state: 'failed', archived: false });
  });

  test("a sub-thread's spend counts against the run's budget, in the sub-thread and in the parent after it", () => {
    const dir = tmp();
    // Every faux turn here costs about the same, so the budget is a turn count: the parent's spawn, then the
    // sub-thread's turns. Before spend was shared, the sub-thread had the whole budget to itself and the parent
    // went on spending after it.
    const one = JSON.parse(cedia(tmp(), [call('c0', 'true'), reply('ok')], ['-p', 'x', ...ws]).out).costUsd / 2;
    const script = [
      tool('s1', 'spawn', { kind: 'work', task: 'Run true three times.' }),
      call('c1', 'true'),
      call('c2', 'true'),
      call('c3', 'true'),
      reply('ran it'),
      call('c4', 'true'),
      reply('done'),
    ];
    const result = JSON.parse(cedia(dir, script, ['-p', 'run true', ...ws, '--max-budget-usd', String(one * 2.5)]).out);
    expect(result.subtype).toBe('error_max_budget_usd');
    expect(result.costUsd).toBeLessThan(one * 4);
    // The sub-thread stopped at the run's budget, not at a budget of its own, and the parent ran nothing after it.
    const parent = sessionsOf(dir).find((l) => l.id === result.sessionId)!;
    const results = parent.events.filter((e): e is EventOf<'tool_result'> => e.kind === 'tool_result');
    expect(results[0]!.output.text).toContain('ended="error_max_budget_usd"');
    const ran = sessionsOf(dir).flatMap((l) => l.events.filter((e): e is EventOf<'tool_result'> => e.kind === 'tool_result' && e.status === 'completed').map((e) => e.callId));
    expect(ran).toEqual(['c1', 'c2']);
  });

  test('--spawn off leaves the tool out', () => {
    const dir = tmp();
    const result = JSON.parse(cedia(dir, [reply('ok')], ['-p', 'hi', '--output-format', 'json', '--spawn', 'off']).out);
    const log = sessionsOf(dir).find((l) => l.id === result.sessionId)!;
    expect(head(log.events).tools.map((t) => t.name)).not.toContain('spawn');
    expect(cedia(tmp(), [], ['-p', 'x', '--spawn', 'maybe']).err).toContain('--spawn must be on or off');
  });
});

describe('project identity across git worktrees', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  const repoWithWorktree = () => {
    const dir = tmp();
    const main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', join(dir, 'wt'));
    return { dir, main: realpathSync(main), wt: realpathSync(join(dir, 'wt')) };
  };

  test('every worktree of a repository is the main worktree’s project; elsewhere the directory is', () => {
    const { main, wt } = repoWithWorktree();
    expect(projectRoot(wt)).toBe(main);
    expect(projectRoot(join(main))).toBe(main);
    expect(projectKey(wt)).toBe(projectSlug(main));
    const plain = tmp();
    expect(projectRoot(plain)).toBe(plain);
  });

  test('a thread started in a worktree is listed, and its session filed, under the main worktree’s project', () => {
    const { dir, main, wt } = repoWithWorktree();
    const scriptPath = join(dir, 'script.json');
    writeFileSync(scriptPath, JSON.stringify([reply('ok')]));
    const env = { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: join(dir, 'home') };
    const run = Bun.spawnSync([BIN, '-m', 'faux', '--cwd', wt, '-p', 'work in the worktree', '--output-format', 'json'], { env, stdin: 'ignore' });
    const result = JSON.parse(run.stdout.toString());
    const listed = Bun.spawnSync([BIN, 'threads', 'list', '--cwd', main], { env }).stdout.toString();
    expect(listed).toContain(result.thread);
    const log = SessionLog.load(join(dir, 'home', 'sessions', projectSlug(main), `${result.sessionId}.jsonl`));
    expect(head(log.events).cwd).toBe(wt);
  });
});
