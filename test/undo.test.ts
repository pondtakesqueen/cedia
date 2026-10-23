import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitStatus, statusText, workingDiff } from '../src/core/project/git.ts';
import { ThreadStore, threadsDir } from '../src/core/project/threads.ts';
import { runTurn } from '../src/core/project/undo.ts';
import { projectKey, SessionLog } from '../src/core/session/log.ts';
import type { SessionEvent } from '../src/core/types.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const call = (id: string, command: string) => ({ blocks: [{ type: 'tool_use', id, name: 'bash', input: { command } }] });
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-undo-'));
  const home = join(dir, '.home');
  writeFileSync(join(dir, 'keep.txt'), 'old\n');
  writeFileSync(join(dir, 'run.sh'), 'echo old\n');
  chmodSync(join(dir, 'run.sh'), 0o755);
  const run = (script: unknown[], args: string[]) => {
    const scriptPath = join(home, `script-${Math.random()}.json`);
    Bun.spawnSync(['mkdir', '-p', home]);
    writeFileSync(scriptPath, JSON.stringify(script));
    const p = Bun.spawnSync([BIN, ...args, '--cwd', dir], { env: { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: home }, stdin: 'ignore' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const store = new ThreadStore(threadsDir(home, projectKey(dir)));
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : undefined);
  return { dir, home, run, store, read };
}

describe('/undo and /redo of the last turn (offline, faux)', () => {
  test('undo puts back exactly the files the turn changed, mode included; redo puts them forward; the thread is told', () => {
    const w = setup();
    const turn = [call('c1', 'echo new > keep.txt; echo hi > added.txt; printf "echo new\\n" > run.sh'), reply('done')];
    const first = w.run(turn, ['-m', 'faux', '-p', 'change things', '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json']);
    expect(first.code).toBe(0);
    const thread = JSON.parse(first.out).thread as string;
    // A file the turn never touched, changed afterwards, stays as the user left it.
    writeFileSync(join(w.dir, 'mine.txt'), 'mine\n');

    const undo = w.run([], ['threads', 'undo', thread]);
    expect(undo.code).toBe(0);
    expect(undo.out).toContain('undid added.txt, keep.txt, run.sh');
    expect(undo.out).toContain('commands the turn ran');
    expect([w.read('keep.txt'), w.read('added.txt'), w.read('run.sh'), w.read('mine.txt')]).toEqual(['old\n', undefined, 'echo old\n', 'mine\n']);
    expect(statSync(join(w.dir, 'run.sh')).mode & 0o111).toBeTruthy();
    // The model hears of it at its next turn, as a message from the user.
    const pending = w.store.read(thread).pending;
    expect(pending.map((m) => m.from)).toEqual(['user']);
    expect(pending[0]!.text).toContain('I ran /undo on your last turn: added.txt, keep.txt, run.sh are back');

    // Again: nothing left to undo.
    expect(w.run([], ['threads', 'undo', thread]).out).toContain('nothing to undo');

    const redo = w.run([], ['threads', 'redo', thread]);
    expect(redo.code).toBe(0);
    expect([w.read('keep.txt'), w.read('added.txt'), w.read('run.sh')]).toEqual(['new\n', 'hi\n', 'echo new\n']);
  });

  test("a file changed after the turn is left alone unless forced, and the next turn's diff and undo are its own", () => {
    const w = setup();
    const first = w.run([call('c1', 'echo new > keep.txt; echo hi > added.txt'), reply('done')], ['-m', 'faux', '-p', 'change things', '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json']);
    const thread = JSON.parse(first.out).thread as string;
    writeFileSync(join(w.dir, 'keep.txt'), 'edited by the user\n');

    const undo = w.run([], ['threads', 'undo', thread]);
    expect(undo.code).toBe(1);
    expect(undo.out).toContain('undid added.txt');
    expect(undo.out).toContain('left keep.txt: changed since the turn');
    expect(w.read('keep.txt')).toBe('edited by the user\n');
    expect(w.store.read(thread).pending[0]!.text).toContain('keep.txt changed after your turn, so it was left as it is');
    // A client reads the same as JSON, and leaving a file is not a failure there.
    const json = w.run([], ['threads', 'undo', thread, '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual({ action: 'undo', restored: [], skipped: ['keep.txt'] });
    expect(w.run([], ['threads', 'undo', thread, '--force']).code).toBe(0);
    expect(w.read('keep.txt')).toBe('old\n');
    expect(JSON.parse(w.run([], ['threads', 'redo', thread, '--json']).out)).toEqual({ action: 'redo', restored: ['added.txt', 'keep.txt'], skipped: [] });
    expect(w.run([], ['threads', 'undo', thread, '--force']).code).toBe(0);

    // The thread's next turn: its diff shows that turn's change only, and undo takes back that turn only.
    const second = w.run([call('c2', 'echo two > second.txt'), reply('done')], ['-m', 'faux', '-p', 'one more', '--thread', thread, '--permission', 'workspace', '--sandbox', 'off']);
    expect(second.code).toBe(0);
    // The undo notes reached the model in that turn, as a logged reminder.
    const log = SessionLog.load(w.store.read(thread).sessions.at(-1)!.path!);
    expect(log.events.some((e) => e.kind === 'reminder' && e.text.includes('I ran /undo on your last turn'))).toBe(true);
    expect(w.store.read(thread).pending).toEqual([]);
    const diff = w.run([], ['threads', 'diff', thread]);
    expect(diff.out).toContain('+++ b/second.txt');
    expect(diff.out).not.toContain('keep.txt');
    expect(w.run([], ['threads', 'undo', thread]).out).toContain('undid second.txt');
    expect(w.read('keep.txt')).toBe('old\n');
  });

  test("a turn is the whole run, across its sessions and prompts (a review's fix, a handoff); one that changed nothing is none", () => {
    let n = 0;
    const e = (body: Record<string, unknown>): SessionEvent => ({ id: `e${n++}`, at: '', ...body }) as unknown as SessionEvent;
    const snap = (tree: string) => e({ kind: 'snapshot', tree, changed: [] });
    const first = [e({ kind: 'user', text: 'earlier' }), snap('t-old'), snap('t0'), e({ kind: 'user', text: 'task' }), snap('t0'), snap('t1'), e({ kind: 'user', text: 'fix what the review found' }), snap('t1'), snap('t2')];
    const second = [e({ kind: 'user', text: 'after a handoff' }), snap('t2'), snap('t3')];
    expect(runTurn([{ events: first, from: 3 }, { events: second, from: 0 }])).toEqual({ before: 't0', after: 't3' });
    expect(runTurn([{ events: [e({ kind: 'user', text: 'a question' })], from: 0 }])).toBeUndefined();
    expect(runTurn([{ events: [snap('t5'), snap('t5')], from: 0 }])).toBeUndefined();
  });

  test('a forced redo refuses, before writing anything, where a directory or a symlinked parent now stands', () => {
    const w = setup();
    const first = w.run([call('c1', 'mkdir -p d && echo a > d/f.txt && echo b > top.txt'), reply('done')], ['-m', 'faux', '-p', 'make files', '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json']);
    const thread = JSON.parse(first.out).thread as string;
    expect(w.run([], ['threads', 'undo', thread]).out).toContain('undid d/f.txt, top.txt');
    // The user puts a directory where top.txt was, and a symlink to a directory of theirs where d was.
    Bun.spawnSync(['sh', '-c', 'mkdir top.txt mine && echo keep > mine/f.txt && ln -s mine d'], { cwd: w.dir });
    const redo = w.run([], ['threads', 'redo', thread, '--force']);
    expect(redo.code).toBe(1);
    expect(redo.err).toMatch(/a parent directory is now a symlink|a directory is there now/);
    expect(w.read('mine/f.txt')).toBe('keep\n');
  });
});

describe('git status line and working diff', () => {
  test('branch, dirty count, ahead; detached; untracked files; outside git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-git-'));
    const git = (...args: string[]) => Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
    expect(gitStatus(dir)).toBeUndefined();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    expect(workingDiff(dir)).toEqual({ patch: '', untracked: ['a.txt'] });
    git('add', '.');
    git('commit', '-qm', 'one');
    writeFileSync(join(dir, 'a.txt'), 'b\n');
    writeFileSync(join(dir, 'new file.txt'), 'n\n');
    git('mv', 'a.txt', 'moved.txt');
    const s = gitStatus(dir)!;
    expect(s).toEqual({ branch: 'main', detached: false, dirty: 2, ahead: 0, behind: 0 });
    expect(statusText(s)).toBe('main +2');
    const d = workingDiff(dir)!;
    expect(d.untracked).toEqual(['new file.txt']);
    expect(d.patch).toContain('+b');
    git('stash', '-u', '-q');
    git('checkout', '-q', '--detach');
    expect(statusText(gitStatus(dir)!)).toMatch(/^detached [0-9a-f]{7}$/);
  });
});
