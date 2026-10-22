import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Terminal } from '@mariozechner/pi-tui';
import { callLine, CediaTui, printable, type TuiArgs } from '../src/clients/tui/main.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { lintSession } from '../src/core/session/lint.ts';

// A terminal that records nothing and takes typed input from the test.
class FakeTerminal implements Terminal {
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void) {
    this.input = onInput;
  }
  stop() {}
  async drainInput() {}
  write() {}
  get columns() {
    return 100;
  }
  get rows() {
    return 40;
  }
  get kittyProtocolActive() {
    return false;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

const call = (id: string, command: string) => ({ blocks: [{ type: 'tool_use', id, name: 'bash', input: { command } }] });
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b_[^\x07]*\x07/g, '');

const saved = { home: process.env.CEDIA_HOME, script: process.env.CEDIA_FAUX_SCRIPT };
let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cedia-tui-'));
  process.env.CEDIA_HOME = join(dir, '.home');
});
afterAll(() => {
  for (const [k, v] of [['CEDIA_HOME', saved.home], ['CEDIA_FAUX_SCRIPT', saved.script]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function app(more: Partial<TuiArgs> = {}) {
  const term = new FakeTerminal();
  let left = false;
  const a = new CediaTui({ cwd: dir, model: 'faux', permission: 'workspace', sandbox: 'off', spawn: 'off', ...more }, term, undefined, () => (left = true));
  a.start();
  const type = (text: string) => {
    term.input(text);
    term.input('\r');
  };
  const script = (steps: unknown[]) => {
    const p = join(dir, `script-${Math.random()}.json`);
    writeFileSync(p, JSON.stringify(steps));
    process.env.CEDIA_FAUX_SCRIPT = p;
  };
  const shown = () => plain(a.chat.render(100).join('\n'));
  return { a, term, type, script, shown, left: () => left };
}

describe('the TUI (offline, faux)', () => {
  test('a prompt runs a turn of a thread and draws it; the next prompt goes on in the same session; /diff, /undo, /redo', async () => {
    writeFileSync(join(dir, 'keep.txt'), 'old\n');
    const t = app();
    t.script([call('c1', 'echo new > keep.txt'), reply('I changed **keep.txt**.')]);
    t.type('change keep.txt');
    expect(t.a.statusLine()).toContain('working');
    await t.a.idle();
    const first = t.shown();
    expect(first).toContain('› change keep.txt');
    expect(first).toContain('● bash echo new > keep.txt');
    expect(first).toContain('changed keep.txt');
    expect(first).toContain('I changed keep.txt.');
    expect(first).toMatch(/done · 2 turns · \$/);
    expect(first).toContain('cedia receipt: changed keep.txt');
    const thread = t.a.thread!;
    expect(thread).toMatch(/^t-/);
    await t.a.settled();
    expect(t.a.statusLine()).toContain(thread);
    expect(t.a.statusLine()).not.toContain('working');

    t.type('/diff');
    expect(t.shown()).toContain("since this thread's last turn started");
    expect(t.shown()).toContain('+new');
    t.type('/undo');
    expect(t.shown()).toContain('undid keep.txt');
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('old\n');
    t.type('/redo');
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('new\n');

    t.script([reply('still here')]);
    t.type('anything else?');
    await t.a.idle();
    expect(t.shown()).toContain('still here');
    expect(t.a.thread).toBe(thread);
    // One session holds both turns, and the undo and redo notes reached the model in it.
    const { ThreadStore, threadsDir } = await import('../src/core/project/threads.ts');
    const { projectKey } = await import('../src/core/session/log.ts');
    const store = new ThreadStore(threadsDir(process.env.CEDIA_HOME!, projectKey(dir)));
    const sessions = store.read(thread).sessions;
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(1);
    const log = SessionLog.load(sessions[0]!.path!);
    expect(log.events.filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text)).toEqual(['change keep.txt', 'anything else?']);
    expect(log.events.some((e) => e.kind === 'reminder' && e.text.includes('I ran /undo'))).toBe(true);
    expect(lintSession(log.events)).toEqual([]);
    t.a.stop();
  });

  test('Esc stops a running turn; Ctrl+C with an empty editor leaves; unknown commands say so', async () => {
    const t = app();
    t.script([call('c1', 'sleep 20'), reply('never')]);
    t.type('wait a while');
    await Bun.sleep(300);
    // What a turn works on waits for it.
    t.type('/diff');
    expect(t.shown()).toContain('a turn is running: stop it (Esc) before /diff');
    t.type('/new');
    expect(t.shown()).toContain('before /new');
    const t0 = Date.now();
    t.term.input('\x1b');
    await t.a.idle();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(t.shown()).toContain('stopping…');
    expect(t.shown()).toContain('interrupted');
    t.type('/nope');
    expect(t.shown()).toContain('unknown command /nope');
    t.term.input('\x03');
    await Bun.sleep(20);
    expect(t.left()).toBe(true);
  });

  test('leaving during a turn stops it and lets it finish its logs first', async () => {
    const t = app();
    t.script([call('c1', 'sleep 20'), reply('never')]);
    t.type('wait');
    await Bun.sleep(300);
    t.type('/quit');
    await t.a.idle();
    await Bun.sleep(20);
    expect(t.left()).toBe(true);
    expect(t.shown()).toContain('interrupted');
  });

  test('/commit takes only the thread\'s files with a drafted message once confirmed; /pr refuses the default branch, then pushes and opens one', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cedia-tui-git-'));
    const git = (...args: string[]) => Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });
    const remote = mkdtempSync(join(tmpdir(), 'cedia-tui-remote-'));
    Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main'], { cwd: remote });
    git('init', '-q', '-b', 'main');
    // /commit runs plain git commit: the repository names who commits, as a runner with no global identity needs.
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'Start');
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'main');
    const term = new FakeTerminal();
    const a = new CediaTui({ cwd: repo, model: 'faux', permission: 'workspace', sandbox: 'off', spawn: 'off' }, term, undefined, () => {});
    a.start();
    const type = (text: string) => (term.input(text), term.input('\r'));
    const script = (steps: unknown[]) => {
      const p = join(repo, '..', `script-${Math.random()}.json`);
      writeFileSync(p, JSON.stringify(steps));
      process.env.CEDIA_FAUX_SCRIPT = p;
    };
    const shown = () => plain(a.chat.render(100).join('\n'));
    script([call('c1', 'echo made > made.txt && echo more >> base.txt'), reply('done')]);
    type('make made.txt');
    await a.idle();
    // The user's own file is not the thread's.
    writeFileSync(join(repo, 'mine.txt'), 'mine\n');
    script([reply('```\nAdd made.txt and extend base.txt\n\nOne line each.\n```')]);
    type('/commit');
    await a.idle();
    expect(shown()).toContain('commit 2 files: base.txt, made.txt');
    expect(shown()).toContain('Add made.txt and extend base.txt');
    type('y');
    await a.idle();
    const log = git('log', '-1', '--format=%B%n--%n', '--name-only').stdout.toString();
    expect(log).toContain('Add made.txt and extend base.txt\n\nOne line each.');
    expect(log).toContain('base.txt');
    expect(log).toContain('made.txt');
    expect(log).not.toContain('mine.txt');
    type('/commit');
    await a.idle();
    expect(shown()).toContain('nothing this thread changed differs from HEAD');

    type('/pr');
    expect(shown()).toContain('main is the default branch: cedia never pushes to it');
    git('switch', '-q', '-c', 'feature');
    const gh = join(remote, 'gh');
    writeFileSync(gh, '#!/bin/sh\necho "https://example.test/pr/1 $*"\n');
    chmodSync(gh, 0o755);
    process.env.CEDIA_GH_BIN = gh;
    type('/pr');
    expect(shown()).toContain('push feature to origin and open a pull request into main?');
    type('no');
    expect(shown()).toContain('not done: the push');
    type('/pr');
    type('y');
    await a.idle();
    delete process.env.CEDIA_GH_BIN;
    expect(shown()).toContain('https://example.test/pr/1 pr create --fill --base main --head feature');
    expect(Bun.spawnSync(['git', 'rev-parse', '--verify', '-q', 'refs/heads/feature'], { cwd: remote }).exitCode).toBe(0);
    a.stop();
  });

  test('a question the writer asks is shown with its options, and the next message answers it', async () => {
    const t = app({ ask: 'on' });
    t.script([{ blocks: [{ type: 'tool_use', id: 'q1', name: 'ask_user', input: { question: 'Keep the old API?', options: ['yes, deprecate it', 'no, remove it'] } }] }]);
    t.type('change the API');
    await t.a.idle();
    expect(t.shown()).toContain('Keep the old API?');
    expect(t.shown()).toContain('2. no, remove it');
    expect(t.shown()).toContain('your next message is the answer');
    t.script([reply('kept it, deprecated')]);
    t.type('1');
    await t.a.idle();
    expect(t.shown()).toContain('kept it, deprecated');
  });

  test('/goal: each turn runs under the condition until /goal off; the judge\'s verdict is shown, and a not met sends the writer back', async () => {
    const t = app();
    t.type('/goal');
    expect(t.shown()).toContain('no goal: /goal <condition> sets one');
    t.type('/goal a.txt and b.txt both exist');
    expect(t.a.goal).toBe('a.txt and b.txt both exist');
    expect(t.a.statusLine()).toContain('goal');
    // Writer, judge (not met), writer again, judge (met): one faux script, in order.
    t.script([
      call('g1', 'echo a > a.txt'),
      reply('made a.txt'),
      reply('b.txt does not exist\nGOAL: not met'),
      call('g2', 'echo b > b.txt'),
      reply('made b.txt too'),
      reply('both files exist\nGOAL: met'),
    ]);
    t.type('make the files');
    await t.a.idle();
    expect(t.shown()).toContain('goal: not met yet (round 1)');
    expect(t.shown()).toContain('goal met after 2 judgements');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('b\n');
    t.type('/goal off');
    expect(t.a.goal).toBeUndefined();
    expect(t.a.statusLine()).not.toContain('goal');
    // Without a goal, a claim of done ends the turn: no judge reads it.
    t.script([reply('nothing to change')]);
    t.type('anything else?');
    await t.a.idle();
    expect(t.shown().match(/goal met after/g)).toHaveLength(1);
    // --goal sets it from the start.
    expect(app({ goal: 'tests pass' }).a.goal).toBe('tests pass');
  });

  test('escapes and control characters from commands never reach the screen', () => {
    expect(printable('a\x1b[2J\x1b[Hb\x1b]0;title\x07c\rd\te\nf\x1b(B')).toBe('abcd\te\nf');
    expect(callLine('bash', { command: 'echo \x1b[31mred' })).toBe('bash echo red');
  });

  test('a call is one line naming what it acts on', () => {
    expect(callLine('bash', { command: 'bun test\n--watch' })).toBe('bash bun test …');
    expect(callLine('edit', { path: 'src/a.ts', edits: [] })).toBe('edit src/a.ts');
    expect(callLine('x', { a: 1 })).toBe('x {"a":1}');
  });
});
