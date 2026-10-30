import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guidePrompt, parseGuide } from '../src/core/project/change-guide.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const call = (id: string, command: string) => ({ blocks: [{ type: 'tool_use', id, name: 'bash', input: { command } }] });
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

test('INTENT and STEP lines become the guide; a step names its file and line when it gives one', () => {
  const g = parseGuide('Some preamble.\nINTENT: adds retries to fetch\nINTENT: users see fewer errors\nSTEP: src/net.ts:10 the new retry loop\n- STEP: the tests\nSTEP:\nnot a step: a.ts:3');
  expect(g).toEqual({ intent: 'adds retries to fetch users see fewer errors', steps: [{ path: 'src/net.ts', line: 10, text: 'src/net.ts:10 the new retry loop' }, { text: 'the tests' }] });
  expect(guidePrompt('diff --git a/x b/x\n', 'head')).toContain('against the last commit');
  expect(guidePrompt('x'.repeat(70_000), 'turn')).toContain('The diff is 70000 characters');
});

test('threads diff takes three bases, and explain-change walks the change read-only (offline, faux)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-guide-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'Start');
  // An upstream to compare with: the branch starts from it and commits one change of its own first.
  git(dir, 'branch', 'upstream-main');
  git(dir, 'switch', '-q', '-c', 'work');
  git(dir, 'branch', '-u', 'upstream-main');
  writeFileSync(join(dir, 'committed.txt'), 'on the branch\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'Branch work');
  const home = join(dir, '.git', 'cedia-home');
  const run = (script: unknown[], args: string[]) => {
    const scriptPath = join(home, `../script-${Math.random()}.json`);
    writeFileSync(scriptPath, JSON.stringify(script));
    const p = Bun.spawnSync([BIN, ...args, '--cwd', dir], { env: { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: home }, stdin: 'ignore' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const first = run([call('c1', 'echo one >> base.txt'), reply('done')], ['-m', 'faux', '-p', 'first', '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json']);
  const thread = JSON.parse(first.out).thread as string;
  run([call('c2', 'echo new > new.txt'), reply('done')], ['-m', 'faux', '-p', 'second', '--thread', thread, '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json']);

  const turn = run([], ['threads', 'diff', thread]).out;
  expect(turn).toContain('new.txt');
  expect(turn).not.toContain('base.txt');
  const head = run([], ['threads', 'diff', thread, '--base', 'head']).out;
  expect(head).toContain('base.txt');
  expect(head).toContain('new.txt');
  expect(head).not.toContain('committed.txt');
  const upstream = run([], ['threads', 'diff', thread, '--base', 'upstream']).out;
  for (const f of ['base.txt', 'new.txt', 'committed.txt']) expect(upstream).toContain(f);
  expect(run([], ['threads', 'diff', thread, '--base', 'nope']).err).toContain('--base is one of turn, head, upstream');

  const guide = run(
    [
      // The guide may not write: the call is refused, and the file stays as it was.
      call('g1', 'echo x > new.txt'),
      reply('INTENT: records two notes\nSTEP: new.txt:1 the new note\nSTEP: base.txt:2 one more line'),
    ],
    ['explain-change', '--thread', thread, '--model', 'faux', '--json'],
  );
  expect(guide.code).toBe(0);
  expect(JSON.parse(guide.out)).toMatchObject({
    model: 'faux/scripted',
    base: 'head',
    intent: 'records two notes',
    steps: [{ path: 'new.txt', line: 1, text: 'new.txt:1 the new note' }, { path: 'base.txt', line: 2, text: 'base.txt:2 one more line' }],
    files: ['base.txt', 'new.txt'],
  });
  expect(Bun.file(join(dir, 'new.txt')).size).toBe(4);
  expect(JSON.parse(run([reply('no steps here')], ['explain-change', '--thread', thread, '--model', 'faux', '--json']).out)).toEqual({ error: 'the model gave no STEP lines' });
});
