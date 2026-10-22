import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Terminal } from '@mariozechner/pi-tui';
import { callLine, CediaTui, printable } from '../src/clients/tui/main.ts';
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

function app() {
  const term = new FakeTerminal();
  let left = false;
  const a = new CediaTui({ cwd: dir, model: 'faux', permission: 'workspace', sandbox: 'off', spawn: 'off' }, term, undefined, () => (left = true));
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
