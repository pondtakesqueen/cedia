import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadStore, threadsDir } from '../src/core/project/threads.ts';
import { projectKey, SessionLog } from '../src/core/session/log.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { settledEvents } from '../src/core/project/fork.ts';
import type { SessionEvent } from '../src/core/types.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const call = (id: string, command: string) => ({ blocks: [{ type: 'tool_use', id, name: 'bash', input: { command } }] });
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-fork-'));
  const home = join(dir, '.home');
  const run = (script: unknown[], args: string[]) => {
    const scriptPath = join(home, `script-${Math.random()}.json`);
    Bun.spawnSync(['mkdir', '-p', home]);
    writeFileSync(scriptPath, JSON.stringify(script));
    const p = Bun.spawnSync([BIN, ...args, '--cwd', dir], { env: { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: home }, stdin: 'ignore' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const prompt = (text: string, script: unknown[], thread?: string) =>
    run(script, ['-m', 'faux', '-p', text, ...(thread ? ['--thread', thread] : []), '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json']);
  const store = new ThreadStore(threadsDir(home, projectKey(dir)));
  return { dir, home, run, prompt, store };
}

const users = (path: string) => SessionLog.load(path).events.flatMap((e) => (e.kind === 'user' ? [e.text] : []));

describe('cedia threads fork (offline, faux)', () => {
  test('at run 2: a new thread goes on from a copy of the session before it, and the original stays as it was', () => {
    const w = setup();
    const thread = JSON.parse(w.prompt('first: write one', [call('c1', 'echo one > one.txt'), reply('done one')]).out).thread as string;
    w.prompt('second: write two', [call('c2', 'echo two > two.txt'), reply('done two')], thread);
    const before = JSON.stringify(w.store.events(thread));

    const f = w.run([], ['threads', 'fork', thread, '2', '--json']);
    expect(f.code).toBe(0);
    const forked = JSON.parse(f.out) as { thread: string; run: string; sessionId: string };
    const original = w.store.read(thread);
    expect(forked.run).toBe(original.runs[1]!.id);
    expect(JSON.stringify(w.store.events(thread))).toBe(before);
    // No file moves: two.txt stays, as the person may still want it.
    expect(existsSync(join(w.dir, 'two.txt'))).toBe(true);

    const t = w.store.read(forked.thread);
    expect(t).toMatchObject({ task: 'first: write one', state: 'stopped', forkOf: { thread, run: forked.run }, runs: [] });
    expect(t.sessions).toMatchObject([{ sessionId: forked.sessionId, why: 'fork', role: 'code' }]);
    const copy = t.sessions[0]!.path!;
    expect(users(copy).join('\n')).toContain('first: write one');
    expect(users(copy).join('\n')).not.toContain('second');
    expect(w.run([], ['threads', 'list']).out).toContain(`(forked from ${thread})`);

    // The edited message goes on in the copy.
    const r = JSON.parse(w.prompt('second, edited: write deux', [call('c3', 'echo deux > deux.txt'), reply('done deux')], forked.thread).out);
    expect(r).toMatchObject({ subtype: 'success', sessionId: forked.sessionId, thread: forked.thread });
    const said = users(copy);
    expect(said.at(-1)).toBe('second, edited: write deux');
    expect(said.join('\n')).not.toContain('second: write two');
    expect(lintSession(SessionLog.load(copy).events)).toEqual([]);
    expect(w.store.read(thread).runs).toHaveLength(2);
  });

  test('at run 1 there is no session to copy; a run id works too; a bad run is an error', () => {
    const w = setup();
    const thread = JSON.parse(w.prompt('first', [reply('ok')]).out).thread as string;
    const id = w.store.read(thread).runs[0]!.id;
    const f = JSON.parse(w.run([], ['threads', 'fork', thread, id, '--json']).out);
    expect(f.sessionId).toBeUndefined();
    expect(w.store.read(f.thread).sessions).toEqual([]);
    expect(w.run([], ['threads', 'fork', thread, '3']).err).toContain('has runs 1 to 1, not 3');
    expect(w.run([], ['threads', 'fork', 'nope', '1']).err).toContain('no thread nope');
  });

  test('end --side: a side chat goes on from the thread as it stands, read-only, and list leaves it out', () => {
    const w = setup();
    const thread = JSON.parse(w.prompt('first: write one', [call('c1', 'echo one > one.txt'), reply('done one')]).out).thread as string;
    w.prompt('second: write two', [call('c2', 'echo two > two.txt'), reply('done two')], thread);
    const before = JSON.stringify(w.store.events(thread));

    const f = w.run([], ['threads', 'fork', thread, 'end', '--side', '--json']);
    expect(f.code).toBe(0);
    const side = JSON.parse(f.out) as { thread: string; run?: string; sessionId: string };
    expect(side.run).toBeUndefined();
    expect(JSON.stringify(w.store.events(thread))).toBe(before);
    const t = w.store.read(side.thread);
    expect(t).toMatchObject({ side: true, forkOf: { thread }, state: 'stopped', title: expect.stringMatching(/^side chat: /) });
    const copy = t.sessions[0]!.path!;
    expect(users(copy).join('\n')).toContain('second: write two');
    expect(w.run([], ['threads', 'list']).out).not.toContain(side.thread);
    expect(w.run([], ['threads', 'list', '--all']).out).toContain(`(side chat of ${thread})`);

    const r = JSON.parse(w.run([reply('It wrote one.txt, then two.txt.')], ['-m', 'faux', '-p', 'what did you write?', '--thread', side.thread, '--permission', 'read-only', '--output-format', 'json']).out);
    expect(r).toMatchObject({ subtype: 'success', sessionId: side.sessionId, thread: side.thread });
    expect(users(copy).at(-1)).toBe('what did you write?');
    expect(lintSession(SessionLog.load(copy).events)).toEqual([]);
    expect(JSON.stringify(w.store.events(thread))).toBe(before);
  });

  test('end stops before a tool call still waiting on its result, and needs a conversation', () => {
    const w = setup();
    const thread = JSON.parse(w.prompt('first', [call('c1', 'echo one > one.txt'), reply('done')]).out).thread as string;
    const path = w.store.read(thread).sessions.at(-1)!.path!;
    const events = SessionLog.load(path).events;
    expect(settledEvents(events)).toBe(events.length);
    const last = events.at(-1)!;
    const waiting = { ...last, kind: 'assistant', blocks: [{ type: 'tool_use', id: 'c9', name: 'bash', input: { command: 'sleep 9' } }] } as unknown as SessionEvent;
    const settled = settledEvents(events);
    expect(settledEvents([...events, waiting])).toBe(settled);
    const done = { ...last, kind: 'tool_result', callId: 'c9', status: 'ok', output: { text: '' } } as unknown as SessionEvent;
    expect(settledEvents([...events, waiting, done])).toBe(settled + 2);

    const empty = w.store.open('nothing yet');
    expect(w.run([], ['threads', 'fork', empty, 'end', '--side']).err).toContain('has no conversation yet');
  });
});
