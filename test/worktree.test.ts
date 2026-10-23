import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { applyWorktree, openWorktree, type Worktree } from '../src/core/project/worktree.ts';
import { openSnapshots } from '../src/core/safety/snapshot.ts';

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-wt-'));
  const work = join(dir, 'repo');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'a.txt'), '1\n2\n3\n4\n5\n6\n7\n8\n');
  writeFileSync(join(work, 'gone.txt'), 'deleted by the parent before the child starts\n');
  writeFileSync(join(work, '.gitignore'), 'deps/\n.env\n');
  git(work, 'init', '-q');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'init');
  // Uncommitted state the child must see: an edit, a new file, a deleted file, an ignored directory.
  writeFileSync(join(work, 'src', 'a.txt'), '1 parent\n2\n3\n4\n5\n6\n7\n8\n');
  writeFileSync(join(work, 'new.txt'), 'not committed\n');
  Bun.spawnSync(['rm', join(work, 'gone.txt')]);
  mkdirSync(join(work, 'deps'));
  writeFileSync(join(work, 'deps', 'lib.js'), 'module\n');
  writeFileSync(join(work, '.env'), 'A=1\n');
  const parent = openSnapshots(work, join(dir, 'store'))!;
  return { dir, work, parent, root: join(dir, 'worktrees') };
}

const open = (r: ReturnType<typeof repo>, name: string) => {
  mkdirSync(r.root, { recursive: true, mode: 0o700 });
  const wt = openWorktree(r.work, r.parent, r.parent.take()!, name, r.root);
  if ('error' in wt) throw new Error(wt.error);
  return wt;
};
const none = () => false;

describe('worktree per work sub-thread', () => {
  test("the child starts from the parent's working tree, uncommitted changes included, with ignored paths brought in", () => {
    const r = repo();
    const wt = open(r, 't-1');
    expect(readFileSync(join(wt.cwd, 'src', 'a.txt'), 'utf8')).toStartWith('1 parent\n');
    expect(readFileSync(join(wt.cwd, 'new.txt'), 'utf8')).toBe('not committed\n');
    expect(existsSync(join(wt.cwd, 'gone.txt'))).toBe(false);
    expect(readFileSync(join(wt.cwd, 'deps', 'lib.js'), 'utf8')).toBe('module\n');
    // An ignored directory is a clone where the filesystem can make one (always on macOS's APFS), else a link.
    const cloned = !lstatSync(join(wt.cwd, 'deps')).isSymbolicLink();
    if (process.platform === 'darwin') expect(cloned).toBe(true);
    if (cloned) {
      // The child may write it, as an install or a build does; the parent's stays as it was.
      writeFileSync(join(wt.cwd, 'deps', 'lib.js'), 'rebuilt\n');
      writeFileSync(join(wt.cwd, 'deps', 'added.js'), 'installed\n');
      expect(readFileSync(join(r.work, 'deps', 'lib.js'), 'utf8')).toBe('module\n');
      expect(existsSync(join(r.work, 'deps', 'added.js'))).toBe(false);
    }
    // An ignored file is a copy: what the child writes there stays there.
    expect(lstatSync(join(wt.cwd, '.env')).isSymbolicLink()).toBe(false);
    writeFileSync(join(wt.cwd, '.env'), 'A=2\n');
    expect(readFileSync(join(r.work, '.env'), 'utf8')).toBe('A=1\n');
    // git works there, and sees the parent's changes as the parent does.
    expect(git(wt.cwd, 'status', '--porcelain')).toContain('src/a.txt');
    // Nothing changed: nothing to apply. The ignored directory is not a change, written to or not.
    expect(applyWorktree(wt, r.parent, none)).toEqual({ files: [], refused: [], conflicts: [] });
    wt.close();
    expect(existsSync(wt.dir)).toBe(false);
    expect(git(r.work, 'worktree', 'list')).not.toContain(wt.dir);
  });

  test('two children that change different lines of one file both land; a change that does not combine is reported and nothing of it is written', () => {
    const r = repo();
    const a = open(r, 't-a');
    const b = open(r, 't-b');
    const c = open(r, 't-c');
    writeFileSync(join(a.cwd, 'src', 'a.txt'), '1 parent\n2\n3\n4\n5\n6\n7\n8 from a\n');
    writeFileSync(join(a.cwd, 'made-by-a.txt'), 'a\n');
    writeFileSync(join(b.cwd, 'src', 'a.txt'), '1 parent\n2\n3\n4 from b\n5\n6\n7\n8\n');
    writeFileSync(join(c.cwd, 'src', 'a.txt'), '1 parent\n2\n3\n4 from c\n5\n6\n7\n8\n');
    writeFileSync(join(c.cwd, 'made-by-c.txt'), 'c\n');
    expect(applyWorktree(a, r.parent, none).files.sort()).toEqual(['made-by-a.txt', 'src/a.txt']);
    expect(applyWorktree(b, r.parent, none).files).toEqual(['src/a.txt']);
    expect(readFileSync(join(r.work, 'src', 'a.txt'), 'utf8')).toBe('1 parent\n2\n3\n4 from b\n5\n6\n7\n8 from a\n');
    const late = applyWorktree(c, r.parent, none);
    expect(late).toEqual({ files: [], refused: [], conflicts: ['src/a.txt'] });
    expect(existsSync(join(r.work, 'made-by-c.txt'))).toBe(false);
    for (const w of [a, b, c] as Worktree[]) w.close();
  });

  test('a lockfile or generated file both changed is not merged by lines: the one written last wins it whole', () => {
    const r = repo();
    writeFileSync(join(r.work, 'bun.lock'), 'a@1\nb@1\nc@1\n');
    writeFileSync(join(r.work, '.gitattributes'), 'gen/** linguist-generated\n');
    mkdirSync(join(r.work, 'gen'));
    writeFileSync(join(r.work, 'gen', 'api.ts'), '1\n2\n3\n4\n5\n6\n');
    const at = (file: string, s: number) => utimesSync(file, s, s);
    const wt = open(r, 't-lww');
    // The child changed both and wrote them last; the parent changed both first. The generated file's changes
    // would merge by lines (first and last line), yet it is taken whole.
    writeFileSync(join(r.work, 'bun.lock'), 'a@2\nb@1\nc@1\n');
    writeFileSync(join(r.work, 'gen', 'api.ts'), 'parent\n2\n3\n4\n5\n6\n');
    writeFileSync(join(wt.cwd, 'bun.lock'), 'a@3\nb@1\nc@1\n');
    writeFileSync(join(wt.cwd, 'gen', 'api.ts'), '1\n2\n3\n4\n5\nchild\n');
    writeFileSync(join(wt.cwd, 'src', 'a.txt'), '1 parent\n2\n3\n4\n5\n6\n7\n8 child\n');
    at(join(r.work, 'bun.lock'), 1000);
    at(join(r.work, 'gen', 'api.ts'), 1000);
    at(join(wt.cwd, 'bun.lock'), 2000);
    at(join(wt.cwd, 'gen', 'api.ts'), 2000);
    const applied = applyWorktree(wt, r.parent, none);
    expect(applied.conflicts).toEqual([]);
    expect(applied.files.sort()).toEqual(['bun.lock', 'gen/api.ts', 'src/a.txt']);
    expect(applied.newest).toEqual(expect.arrayContaining([{ file: 'bun.lock', kept: 'its' }, { file: 'gen/api.ts', kept: 'its' }]));
    expect(readFileSync(join(r.work, 'bun.lock'), 'utf8')).toBe('a@3\nb@1\nc@1\n');
    expect(readFileSync(join(r.work, 'gen', 'api.ts'), 'utf8')).toBe('1\n2\n3\n4\n5\nchild\n');
    wt.close();

    // Now the parent wrote last: its lockfile stays, and the child's other change still lands.
    const late = open(r, 't-lww-late');
    writeFileSync(join(late.cwd, 'bun.lock'), 'a@4\nb@1\nc@1\n');
    writeFileSync(join(late.cwd, 'made.txt'), 'x\n');
    writeFileSync(join(r.work, 'bun.lock'), 'a@5\nb@1\nc@1\n');
    at(join(late.cwd, 'bun.lock'), 3000);
    at(join(r.work, 'bun.lock'), 4000);
    expect(applyWorktree(late, r.parent, none)).toEqual({ files: ['made.txt'], refused: [], conflicts: [], newest: [{ file: 'bun.lock', kept: 'yours' }] });
    expect(readFileSync(join(r.work, 'bun.lock'), 'utf8')).toBe('a@5\nb@1\nc@1\n');
    late.close();

    // A real conflict elsewhere still writes nothing, the lockfile included.
    const both = open(r, 't-lww-conflict');
    writeFileSync(join(both.cwd, 'bun.lock'), 'a@6\nb@1\nc@1\n');
    writeFileSync(join(both.cwd, 'new.txt'), 'child\n');
    writeFileSync(join(r.work, 'new.txt'), 'parent\n');
    expect(applyWorktree(both, r.parent, none)).toEqual({ files: [], refused: [], conflicts: ['new.txt'] });
    expect(readFileSync(join(r.work, 'bun.lock'), 'utf8')).toBe('a@5\nb@1\nc@1\n');
    both.close();
  });

  test("the parent's own edits since the child started stay; a refused file is left out and named", () => {
    const r = repo();
    const wt = open(r, 't-2');
    writeFileSync(join(r.work, 'new.txt'), 'the parent changed it meanwhile\n');
    writeFileSync(join(wt.cwd, 'src', 'a.txt'), 'child\n');
    mkdirSync(join(wt.cwd, '.vscode'));
    writeFileSync(join(wt.cwd, '.vscode', 'settings.json'), '{}\n');
    const applied = applyWorktree(wt, r.parent, (f) => f.startsWith('.vscode/'));
    expect(applied).toEqual({ files: ['src/a.txt'], refused: ['.vscode/settings.json'], conflicts: [] });
    expect(readFileSync(join(r.work, 'new.txt'), 'utf8')).toBe('the parent changed it meanwhile\n');
    expect(readFileSync(join(r.work, 'src', 'a.txt'), 'utf8')).toBe('child\n');
    expect(existsSync(join(r.work, '.vscode'))).toBe(false);
    wt.close();
  });

  test('a worktree whose directory was swapped for a link is not read; a nested repository is not written', () => {
    const r = repo();
    const elsewhere = mkdtempSync(join(tmpdir(), 'cedia-wt-elsewhere-'));
    writeFileSync(join(elsewhere, 'id_rsa'), 'secret\n');
    const wt = open(r, 't-swap');
    renameSync(wt.dir, `${wt.dir}.bak`);
    symlinkSync(elsewhere, wt.dir);
    expect(() => applyWorktree(wt, r.parent, none)).toThrow('moved or replaced');
    expect(existsSync(join(r.work, 'id_rsa'))).toBe(false);
    expect(existsSync(join(r.work, 'src', 'a.txt'))).toBe(true);
    rmSync(wt.dir);
    renameSync(`${wt.dir}.bak`, wt.dir);
    wt.close();

    const nested = open(r, 't-nested');
    mkdirSync(join(nested.cwd, 'sub'));
    writeFileSync(join(nested.cwd, 'sub', 'f.txt'), 'x\n');
    git(join(nested.cwd, 'sub'), 'init', '-q');
    git(join(nested.cwd, 'sub'), 'add', '-A');
    git(join(nested.cwd, 'sub'), 'commit', '-qm', 'x');
    writeFileSync(join(nested.cwd, 'ok.txt'), 'ok\n');
    expect(applyWorktree(nested, r.parent, none)).toEqual({ files: ['ok.txt'], refused: ['sub'], conflicts: [] });
    expect(existsSync(join(r.work, 'sub'))).toBe(false);
    nested.close();
  });

  test('a kept worktree keeps its directory but not its index; a crash leaves nothing the next one does not sweep', () => {
    const r = repo();
    const indexes = () => readdirSync(join(r.dir, 'store')).filter((f) => f.startsWith('cedia-index-'));
    const kept = open(r, 't-kept');
    kept.keep();
    expect(existsSync(kept.cwd)).toBe(true);
    expect(indexes()).toEqual([]);
    const crashed = open(r, 't-crashed');
    expect(indexes()).toHaveLength(1);
    rmSync(crashed.dir, { recursive: true, force: true });
    const next = open(r, 't-next');
    expect(indexes()).toEqual([basename(next.dir)].map((id) => `cedia-index-${id}`));
    expect(git(r.work, 'worktree', 'list')).not.toContain(crashed.dir);
    next.close();
    kept.close();
  });

  test('outside a repository, or one with no commit, there is no worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-wt-plain-'));
    const parent = openSnapshots(dir, join(dir, '.store'))!;
    expect(openWorktree(dir, parent, parent.take()!, 'x', join(dir, '.wts'))).toEqual({ error: 'not in a git repository' });
    git(dir, 'init', '-q');
    expect(openWorktree(dir, parent, parent.take()!, 'x', join(dir, '.wts'))).toEqual({ error: 'the repository has no commit yet' });
  });
});

describe('isolated calls in the loop', () => {
  test('run beside each other; their writes run one at a time, each between two snapshots that name its files', async () => {
    const { runPrompt } = await import('../src/core/loop/run.ts');
    const { FAUX_MODEL } = await import('../src/core/providers/catalog.ts');
    const { fauxProvider, text, toolUse } = await import('../src/core/providers/faux.ts');
    const { SessionLog } = await import('../src/core/session/log.ts');
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-iso-'));
    let started = 0;
    let release = () => {};
    const both = new Promise<void>((r) => (release = r));
    let inWrite = 0;
    let overlapped = false;
    const iso = {
      name: 'iso',
      description: 'isolated',
      schema: { type: 'object', properties: { f: { type: 'string' } }, required: ['f'] },
      effect: 'write_workspace' as const,
      isolated: () => true,
      replay: 'unsafe' as const,
      async run(input: Record<string, unknown>, ctx: { write?: <T>(fn: () => Promise<T> | T) => Promise<T> }) {
        // Neither finishes until both have started: run one after the other, this would never end.
        if (++started === 2) release();
        await both;
        await ctx.write!(async () => {
          overlapped ||= inWrite > 0;
          inWrite++;
          writeFileSync(join(cwd, String(input.f)), 'x\n');
          await Bun.sleep(20);
          inWrite--;
        });
        return { text: `wrote ${input.f}`, isError: false };
      },
    };
    const log = SessionLog.create();
    await runPrompt(
      {
        log,
        provider: fauxProvider([{ blocks: [toolUse('i1', 'iso', { f: 'one.txt' }), toolUse('i2', 'iso', { f: 'two.txt' })] }, { blocks: [text('done')] }]),
        model: FAUX_MODEL,
        tools: [iso],
        system: 'sys',
        cwd,
        permission: { mode: 'workspace', allow: [], deny: [] },
        snapshots: openSnapshots(cwd, join(mkdtempSync(join(tmpdir(), 'cedia-iso-store-')), 's'))!,
      },
      'go',
    );
    expect(overlapped).toBe(false);
    const snaps = log.events.filter((e) => e.kind === 'snapshot' && e.callId);
    expect(snaps.map((e) => (e as { changed: string[] }).changed).sort()).toEqual([['one.txt'], ['two.txt']]);
  }, 10_000);
});

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const reply = (text: string, when?: string) => ({ blocks: [{ type: 'text', text }], ...(when ? { when } : {}) });
const call = (id: string, command: string, when?: string) => ({ blocks: [{ type: 'tool_use', id, name: 'bash', input: { command } }], ...(when ? { when } : {}) });
const spawnCall = (id: string, task: string) => ({ type: 'tool_use', id, name: 'spawn', input: { kind: 'work', task } });

function cedia(dir: string, script: unknown[], args: string[]) {
  const home = join(dir, '..', 'home');
  mkdirSync(home, { recursive: true });
  const scriptPath = join(home, `script-${crypto.randomUUID()}.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
  const p = Bun.spawnSync([BIN, '-m', 'faux', '--cwd', dir, '--output-format', 'json', '--permission', 'workspace', ...(args.includes('--sandbox') ? [] : ['--sandbox', 'off']), '--check', 'true', ...args], {
    env: { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: home },
    stdin: 'ignore',
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), result: () => JSON.parse(p.stdout.toString()) };
}
// A child's steps, kept for the child whose task holds `key`.
const child = (key: string, command: string, said: string) => [call(`${key}-1`, command, key), call(`${key}-2`, 'true', key), reply(said, key)];
const report = (out: { sessionId: string }, dir: string, callId: string) => {
  const { SessionLog, projectSlug } = require('../src/core/session/log.ts');
  // Sessions are kept under the real path (macOS's temp dir is behind a symlink).
  const root = join(dir, '..', 'home', 'sessions', projectSlug(require('node:fs').realpathSync(dir)));
  const log = require('node:fs')
    .readdirSync(root)
    .map((f: string) => SessionLog.load(join(root, f)))
    .find((l: { id: string }) => l.id === out.sessionId);
  return log.events.find((e: { kind: string; callId?: string }) => e.kind === 'tool_result' && e.callId === callId).output.text as string;
};

describe('--spawn worktree (offline, faux)', () => {
  test('two work sub-threads run in worktrees of their own; both changes reach the working tree and the worktrees go', () => {
    const r = repo();
    const out = cedia(
      r.work,
      [
        { blocks: [spawnCall('s1', 'alpha-task: write good to one.txt'), spawnCall('s2', 'beta-task: write good to two.txt')] },
        ...child('alpha-task', 'echo good > one.txt', 'alpha done'),
        ...child('beta-task', 'echo good > two.txt', 'beta done'),
        call('p1', 'true'),
        reply('both done'),
      ],
      ['-p', 'make both files', '--spawn', 'worktree'],
    );
    const result = out.result();
    expect(result).toMatchObject({ subtype: 'success', result: 'both done' });
    expect(readFileSync(join(r.work, 'one.txt'), 'utf8')).toBe('good\n');
    expect(readFileSync(join(r.work, 'two.txt'), 'utf8')).toBe('good\n');
    expect(result.evidence.changed).toEqual(expect.arrayContaining(['one.txt', 'two.txt']));
    expect(report(result, r.work, 's1')).toContain('Applied to your files: one.txt');
    expect(report(result, r.work, 's2')).toContain('Applied to your files: two.txt');
    expect(git(r.work, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  test("a plan's parts run at once in worktrees of their own before the writer starts", () => {
    const r = repo();
    const plan = 'Then check.\n<part files="one.txt">alpha-task: write good to one.txt</part>\n<part files="two.txt">beta-task: write good to two.txt</part>';
    const out = cedia(
      r.work,
      [reply(plan), ...child('alpha-task', 'echo good > one.txt', 'alpha done'), ...child('beta-task', 'echo good > two.txt', 'beta done'), call('p1', 'true'), reply('both in')],
      ['-p', 'make both files', '--spawn', 'worktree', '--plan', 'faux/fallback', '--plan-when', 'always'],
    );
    const result = out.result();
    expect(result).toMatchObject({ subtype: 'success', result: 'both in', subthreads: 2, spawned: { work: 2 } });
    expect(readFileSync(join(r.work, 'one.txt'), 'utf8')).toBe('good\n');
    expect(readFileSync(join(r.work, 'two.txt'), 'utf8')).toBe('good\n');
    expect(result.evidence.changed).toEqual(expect.arrayContaining(['one.txt', 'two.txt']));
    expect(git(r.work, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  test('best of N: each approach runs in a worktree of its own, cedia runs the checks in each, and only the one that passes most is applied', () => {
    const r = repo();
    const race = { type: 'tool_use', id: 's1', name: 'spawn', input: { kind: 'work', task: 'make out.txt', approaches: ['approach-bad: write bad', 'approach-good: write good'] } };
    const out = cedia(
      r.work,
      [
        { blocks: [race] },
        ...child('approach-bad', 'echo bad > out.txt && echo extra > bad-only.txt', 'bad done'),
        ...child('approach-good', 'echo good > out.txt', 'good done'),
        call('p1', 'grep -q good out.txt'),
        reply('kept the good one'),
      ],
      ['-p', 'make out.txt', '--spawn', 'worktree', '--check', 'grep -q good out.txt'],
    );
    const result = out.result();
    expect(result).toMatchObject({ subtype: 'success', result: 'kept the good one' });
    expect(readFileSync(join(r.work, 'out.txt'), 'utf8')).toBe('good\n');
    expect(existsSync(join(r.work, 'bad-only.txt'))).toBe(false);
    const text = report(result, r.work, 's1');
    expect(text).toContain("Best of 2: kept approach 2; the others' changes were dropped.");
    expect(text).toContain('1. approach-bad: write bad: 1/2 checks passed');
    expect(text).toContain('2. approach-good: write good: 2/2 checks passed, ended success');
    expect(text).toContain('Applied to your files: out.txt');
    expect(result.spawned).toMatchObject({ work: 2 });
    // Both worktrees are gone: the kept one once applied, the other once dropped.
    expect(git(r.work, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  // The sandbox that keeps a child's bash inside its worktree, as runs have it; Seatbelt is always there on macOS.
  test.skipIf(process.platform !== 'darwin')('a sandboxed child may install into its cloned ignored directory; only its tracked change comes back', () => {
    const r = repo();
    const out = cedia(
      r.work,
      [{ blocks: [spawnCall('s1', 'alpha-task: install and write')] }, ...child('alpha-task', 'echo installed > deps/added.js && echo rebuilt > deps/lib.js && echo good > one.txt', 'alpha done'), call('p1', 'true'), reply('done')],
      ['-p', 'install and write', '--spawn', 'worktree', '--sandbox', 'on'],
    );
    expect(out.result()).toMatchObject({ subtype: 'success' });
    expect(report(out.result(), r.work, 's1')).toContain('Applied to your files: one.txt');
    expect(readFileSync(join(r.work, 'one.txt'), 'utf8')).toBe('good\n');
    expect(readFileSync(join(r.work, 'deps', 'lib.js'), 'utf8')).toBe('module\n');
    expect(existsSync(join(r.work, 'deps', 'added.js'))).toBe(false);
  });

  test('a change that conflicts is not applied: the report says so and the worktree stays to be read', () => {
    const r = repo();
    const out = cedia(
      r.work,
      [
        { blocks: [spawnCall('s1', 'alpha-task: edit line 4'), spawnCall('s2', 'beta-task: edit line 4 too')] },
        // The whole file rather than sed -i, which BSD sed (macOS) reads differently.
        ...child('alpha-task', "printf '1 parent\\n2\\n3\\n4 alpha\\n5\\n6\\n7\\n8\\n' > src/a.txt", 'alpha done'),
        ...child('beta-task', "printf '1 parent\\n2\\n3\\n4 beta\\n5\\n6\\n7\\n8\\n' > src/a.txt", 'beta done'),
        call('p1', 'true'),
        reply('one of them conflicted'),
      ],
      ['-p', 'edit line 4', '--spawn', 'worktree'],
    );
    const result = out.result();
    const reports = [report(result, r.work, 's1'), report(result, r.work, 's2')];
    const lost = reports.find((t) => t.includes('Not applied'))!;
    expect(lost).toContain('conflict with yours');
    expect(lost).toContain('src/a.txt');
    const kept = lost.match(/Its worktree stays at (\S+) for you to read/)![1]!;
    expect(existsSync(join(kept, 'src', 'a.txt'))).toBe(true);
    expect(reports.filter((t) => t.includes('Applied to your files: src/a.txt'))).toHaveLength(1);
    expect(readFileSync(join(r.work, 'src', 'a.txt'), 'utf8')).toMatch(/^1 parent\n2\n3\n4 (alpha|beta)\n/);
  });

  test('a child whose check never passed still brings its changes back, marked unverified, and the parent must check', () => {
    const r = repo();
    const out = cedia(
      r.work,
      [{ blocks: [spawnCall('s1', 'alpha-task: one file')] }, call('alpha-1', 'echo good > one.txt', 'alpha-task'), reply('done', 'alpha-task'), reply('done', 'alpha-task'), call('p1', 'true'), reply('done')],
      ['-p', 'x', '--spawn', 'worktree'],
    );
    const text = report(out.result(), r.work, 's1');
    expect(text).toContain('ended="error_unverified_claim"');
    expect(text).toContain('Changed: one.txt (no passing check after: one.txt)');
    expect(text).toContain('Applied to your files: one.txt');
    expect(readFileSync(join(r.work, 'one.txt'), 'utf8')).toBe('good\n');
    expect(git(r.work, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  test("a file the parent may not write is left out; outside git a work sub-thread runs in place, alone", () => {
    const r = repo();
    const out = cedia(
      r.work,
      [{ blocks: [spawnCall('s1', 'alpha-task: settings')] }, ...child('alpha-task', 'mkdir -p .vscode && echo {} > .vscode/settings.json && echo ok > ok.txt', 'alpha done'), call('p1', 'true'), reply('done')],
      ['-p', 'settings', '--spawn', 'worktree'],
    );
    const text = report(out.result(), r.work, 's1');
    expect(text).toContain('Applied to your files: ok.txt');
    expect(text).toContain('Not applied, since you may not write them: .vscode/settings.json');
    expect(existsSync(join(r.work, '.vscode'))).toBe(false);

    // The parent's own deny rules hold for what comes back, even for a write the rule could not see in the
    // command (`$n.txt` names locked.txt only when it runs).
    const denied = cedia(r.work, [{ blocks: [spawnCall('s1', 'alpha-task: two files')] }, ...child('alpha-task', 'n=locked; echo x > $n.txt && echo ok > fine.txt', 'alpha done'), call('p1', 'true'), reply('done')], ['-p', 'files', '--spawn', 'worktree', '--deny', 'edit(locked.txt)']);
    const deniedText = report(denied.result(), r.work, 's1');
    expect(deniedText).toContain('Applied to your files: fine.txt');
    expect(deniedText).toContain('Not applied, since you may not write them: locked.txt');
    expect(existsSync(join(r.work, 'locked.txt'))).toBe(false);

    const plain = mkdtempSync(join(tmpdir(), 'cedia-wt-plain-'));
    mkdirSync(join(plain, 'w'));
    const inPlace = cedia(join(plain, 'w'), [{ blocks: [spawnCall('s1', 'alpha-task: one file')] }, ...child('alpha-task', 'echo good > one.txt', 'alpha done'), call('p1', 'true'), reply('done')], ['-p', 'x', '--spawn', 'worktree']);
    expect(inPlace.err).toContain('no worktree for the work sub-thread (not in a git repository); it runs in place');
    expect(inPlace.result()).toMatchObject({ subtype: 'success' });
    expect(readFileSync(join(plain, 'w', 'one.txt'), 'utf8')).toBe('good\n');
    // Three runs, each with a worktree: past the default 5 s on a slow macOS runner.
  }, 20_000);
});

describe('--spawn worktree in the OS sandbox', () => {
  test.skipIf(!process.env.CEDIA_REQUIRE_SANDBOX && !Bun.which('bwrap') && process.platform !== 'darwin')("a child's bash writes only in its worktree, never the parent's files", () => {
    const r = repo();
    const leak = join(r.work, 'leak.txt');
    const out = cedia(
      r.work,
      [{ blocks: [spawnCall('s1', 'alpha-task: one file')] }, ...child('alpha-task', `echo x > ${leak}; echo good > one.txt; echo tmp > "$TMPDIR/cedia-wt-probe"`, 'alpha done'), call('p1', 'true'), reply('done')],
      ['-p', 'x', '--spawn', 'worktree', '--sandbox', 'on'],
    );
    expect(out.result()).toMatchObject({ subtype: 'success' });
    expect(existsSync(leak)).toBe(false);
    expect(readFileSync(join(r.work, 'one.txt'), 'utf8')).toBe('good\n');
    expect(report(out.result(), r.work, 's1')).toContain('Applied to your files: one.txt');
  });
});

test('warm records the tree in the background, and take afterwards gives the same tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-warm-'));
  for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.txt`), `file ${i}\n`);
  const stores = mkdtempSync(join(tmpdir(), 'cedia-warm-stores-'));
  const snaps = openSnapshots(dir, join(stores, 'a'))!;
  await snaps.warm!();
  const other = openSnapshots(dir, join(stores, 'b'))!;
  expect(snaps.take()).toBe(other.take()!);
});
