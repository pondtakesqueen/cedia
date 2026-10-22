import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldThread, ThreadStore, threadsDir, type ThreadEvent } from '../src/core/project/threads.ts';
import { projectKey, SessionLog } from '../src/core/session/log.ts';
import { lintSession } from '../src/core/session/lint.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const call = (id: string, command: string) => ({ blocks: [{ type: 'tool_use', id, name: 'bash', input: { command } }] });
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-rewind-'));
  const home = join(dir, '.home');
  writeFileSync(join(dir, 'a.txt'), 'start\n');
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
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : undefined);
  return { dir, home, run, prompt, store, read };
}

const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);

describe('/rewind: conversation and files together (offline, faux)', () => {
  test('back to before run 2: its files go back, the thread goes on in a copy of the session as it was, and the model is told', () => {
    const w = setup();
    const first = w.prompt('first: write one', [call('c1', 'echo one > one.txt; echo first > a.txt'), reply('done one')]);
    expect(first.code).toBe(0);
    const thread = JSON.parse(first.out).thread as string;
    w.prompt('second: write two', [call('c2', 'echo two > two.txt; echo second > a.txt'), reply('done two')], thread);
    w.prompt('third: write three', [call('c3', 'echo three > three.txt'), reply('done three')], thread);
    const before = w.store.read(thread);
    expect(before.runs.map((r) => r.prompt)).toEqual(['first: write one', 'second: write two', 'third: write three']);
    const session = before.sessions.at(-1)!;

    const list = w.run([], ['threads', 'rewind', thread]);
    expect(list.out).toContain('run 2');
    expect(list.out).toContain('second: write two');

    const r = w.run([], ['threads', 'rewind', thread, '2']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('rewound to before run "second: write two"');
    expect(r.out).toContain('put back a.txt, three.txt, two.txt');
    expect([w.read('one.txt'), w.read('a.txt'), w.read('two.txt'), w.read('three.txt')]).toEqual(['one\n', 'first\n', undefined, undefined]);

    const after = w.store.read(thread);
    expect(after.runs.map((r) => r.prompt)).toEqual(['first: write one']);
    expect(after.turns).toHaveLength(1);
    expect(after.result).toBe('done one');
    expect(after.rewound).toEqual([session.sessionId]);
    const copy = after.sessions.at(-1)!;
    expect(copy.why).toBe('rewind');
    // The copy is the old session's first run, byte for byte: the same cached prefix.
    const kept = lines(copy.path!);
    expect(kept).toEqual(lines(session.path!).slice(0, kept.length));
    expect(kept.join('\n')).not.toContain('second: write two');
    expect(lintSession(SessionLog.load(copy.path!).events)).toEqual([]);
    expect(after.pending.at(-1)!.text).toContain('I rewound this thread to just before I asked: "second: write two"');

    // The next run goes on in the copy: run 1's conversation, the note, then the new prompt.
    const next = w.prompt('fourth: write four', [call('c4', 'echo four > four.txt'), reply('done four')], thread);
    expect(next.code).toBe(0);
    const log = SessionLog.load(copy.path!);
    const users = log.events.flatMap((e) => (e.kind === 'user' ? [e.text] : []));
    expect(users.some((u) => u.includes('first: write one'))).toBe(true);
    expect(users.some((u) => u.includes('second: write two'))).toBe(false);
    expect(log.events.some((e) => e.kind === 'reminder' && e.text.includes('I rewound this thread'))).toBe(true);
    expect(w.store.read(thread).runs.map((r) => r.prompt)).toEqual(['first: write one', 'fourth: write four']);
  });

  test('a file changed after the run that wrote it is left unless forced; rewinding to run 1 leaves no session', () => {
    const w = setup();
    const first = w.prompt('first', [call('c1', 'echo first > a.txt'), reply('done')]);
    const thread = JSON.parse(first.out).thread as string;
    w.prompt('second', [call('c2', 'echo second > a.txt; echo b > b.txt'), reply('done')], thread);
    writeFileSync(join(w.dir, 'b.txt'), 'edited by the user\n');

    const r = w.run([], ['threads', 'rewind', thread, '1']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('put back a.txt');
    expect(r.out).toContain('left b.txt: changed since the run that wrote it');
    expect(r.out).toContain('the next run starts a new session from the task');
    expect([w.read('a.txt'), w.read('b.txt')]).toEqual(['start\n', 'edited by the user\n']);
    const t = w.store.read(thread);
    expect(t.runs).toEqual([]);
    expect(t.sessions.every((s) => t.rewound.includes(s.sessionId))).toBe(true);

    // The next run opens a new session.
    const next = w.prompt('again', [reply('fresh')], thread);
    expect(next.code).toBe(0);
    const t2 = w.store.read(thread);
    expect(t2.sessions.at(-1)!.why).toBe('resume');
    expect(t2.rewound).not.toContain(t2.sessions.at(-1)!.sessionId);

    expect(w.run([], ['threads', 'rewind', thread, '5']).err).toContain('has runs 1 to 1, not 5');
  });
});

describe('the thread fold after a rewind', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  test('drops what came from the run on, keeps messages, and a message delivered only to a dropped session waits again', () => {
    const events: ThreadEvent[] = [
      { at: at(0), kind: 'open', title: 't', task: 'task' },
      { at: at(1), kind: 'run', id: 'r-1', prompt: 'one', cwd: '/w' },
      { at: at(2), kind: 'session', sessionId: 's1', model: 'm', role: 'code', why: 'start' },
      { at: at(3), kind: 'state', state: 'done', result: 'one done' },
      { at: at(4), kind: 'run', id: 'r-2', prompt: 'two', cwd: '/w', from: { sessionId: 's1', path: '/p', events: 5, model: 'm' } },
      { at: at(5), kind: 'message', id: 'm1', from: 't-other', text: 'hello' },
      { at: at(6), kind: 'delivered', ids: ['m1'], sessionId: 's1' },
      { at: at(7), kind: 'turn', cwd: '/w', before: 'a', after: 'b', sessions: ['s1'] },
      { at: at(8), kind: 'state', state: 'failed', result: 'two failed' },
      { at: at(9), kind: 'rate', rating: 'down' },
      { at: at(10), kind: 'rewind', run: 'r-2' },
      { at: at(11), kind: 'session', sessionId: 's2', model: 'm', role: 'code', why: 'rewind' },
      // A rewind to a run an earlier one dropped changes nothing.
      { at: at(12), kind: 'rewind', run: 'r-2' },
    ];
    const t = foldThread('t-00000000', events);
    expect(t.runs.map((r) => r.id)).toEqual(['r-1']);
    expect(t.state).toBe('done');
    expect(t.result).toBe('one done');
    expect(t.turns).toEqual([]);
    expect(t.lastTurn).toBeUndefined();
    expect(t.pending.map((m) => m.id)).toEqual(['m1']);
    expect(t.ratings).toHaveLength(1);
    expect(t.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(t.rewound).toEqual([]);
  });
});
