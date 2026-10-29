import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFindings } from '../src/core/project/code-review.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const call = (id: string, command: string) => ({ blocks: [{ type: 'tool_use', id, name: 'bash', input: { command } }] });
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

test('FINDING lines become findings with their file and line; an id stays the same for the same finding', () => {
  const got = parseFindings('Read both files.\nFINDING: `src/a.ts:12` drops the last item\n- FINDING: the tests are gone\nnot a finding: b.ts:3');
  expect(got.map(({ id: _, ...f }) => f)).toEqual([
    { path: 'src/a.ts', line: 12, text: '`src/a.ts:12` drops the last item' },
    { text: 'the tests are gone' },
  ]);
  expect(parseFindings('FINDING: `src/a.ts:12` drops the last item')[0]!.id).toBe(got[0]!.id);
  expect(got[0]!.id).not.toBe(got[1]!.id);
});

test("cedia review reviews the thread's files read-only and names each finding's file and line", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-review-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'Start');
  const home = join(dir, '.git', 'cedia-home');
  const run = (script: unknown[], args: string[]) => {
    const scriptPath = join(home, `../script-${Math.random()}.json`);
    writeFileSync(scriptPath, JSON.stringify(script));
    const p = Bun.spawnSync([BIN, ...args, '--cwd', dir], { env: { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: home }, stdin: 'ignore' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const none = run([reply('done')], ['-m', 'faux', '-p', 'look around', '--output-format', 'json']);
  const idle = JSON.parse(none.out).thread as string;
  expect(JSON.parse(run([], ['review', '--thread', idle, '--json']).out)).toEqual({ error: 'nothing this thread changed differs from HEAD' });

  const made = run([call('c1', 'echo more >> base.txt && echo new > new.txt'), reply('done')], ['-m', 'faux', '-p', 'change things', '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json']);
  expect(made.code).toBe(0);
  const thread = JSON.parse(made.out).thread as string;
  const review = run(
    [
      // The review may not write: the call is refused, and the file stays as it was.
      call('r1', 'echo x > new.txt'),
      reply('I read both files.\nFINDING: base.txt:2 adds a line nobody asked for\nFINDING: other.ts:4 is wrong too\nVERDICT: changes'),
    ],
    ['review', '--thread', thread, '--model', 'faux', '--json'],
  );
  expect(review.code).toBe(0);
  const r = JSON.parse(review.out);
  expect(r).toMatchObject({ model: 'faux/scripted', verdict: 'changes', files: ['base.txt', 'new.txt'], summary: 'I read both files.', dropped: [{ ref: 'other.ts:4', reason: 'not in the diff' }] });
  expect(r.findings).toEqual([{ id: expect.any(String), path: 'base.txt', line: 2, text: 'base.txt:2 adds a line nobody asked for' }]);
  expect(Bun.file(join(dir, 'new.txt')).size).toBe(4);
});
