import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimThread, holderOf, isCediaProcess } from '../src/core/project/busy.ts';
import { ThreadStore, threadsDir } from '../src/core/project/threads.ts';
import { projectKey } from '../src/core/session/log.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

function store() {
  const s = new ThreadStore(mkdtempSync(join(tmpdir(), 'cedia-busy-')));
  const id = s.open('task');
  return { s, id };
}

describe('one run of a thread at a time', () => {
  test('a run with no state after it, held by a live process, holds the thread; the same process, a dead one, or an ended run do not', () => {
    const { s, id } = store();
    s.append(id, { kind: 'run', id: 'r-1', prompt: 'p', cwd: '/', pid: 4242 });
    const alive = (pid: number) => pid === 4242;
    expect(holderOf(s.read(id), 1, alive)).toEqual({ pid: 4242, run: 'r-1' });
    expect(holderOf(s.read(id), 4242, alive)).toBeUndefined();
    expect(holderOf(s.read(id), 1, () => false)).toBeUndefined();
    s.append(id, { run: 'r-1', kind: 'state', state: 'done' });
    expect(holderOf(s.read(id), 1, alive)).toBeUndefined();
  });

  test('a run recorded before cedia wrote its pid holds nothing', () => {
    const { s, id } = store();
    s.append(id, { kind: 'run', id: 'r-1', prompt: 'p', cwd: '/' });
    expect(holderOf(s.read(id), 1, () => true)).toBeUndefined();
  });

  test('a held thread is refused; --take-over stops the holder and waits for its state', async () => {
    const { s, id } = store();
    s.append(id, { kind: 'run', id: 'r-1', prompt: 'p', cwd: '/', pid: 4242 });
    const alive = () => true;
    const refused = await claimThread(s, id, { self: 1, alive });
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.error).toContain('--take-over');
    const killed: number[] = [];
    const took = await claimThread(s, id, { self: 1, alive, takeOver: true, kill: (pid) => { killed.push(pid); s.append(id, { run: 'r-1', kind: 'state', state: 'stopped' }); } });
    expect(killed).toEqual([4242]);
    expect(took).toEqual({ ok: true, tookOver: { pid: 4242, run: 'r-1' } });
  });

  test('a holder that does not stop keeps the thread', async () => {
    const { s, id } = store();
    s.append(id, { kind: 'run', id: 'r-1', prompt: 'p', cwd: '/', pid: 4242 });
    const r = await claimThread(s, id, { self: 1, alive: () => true, takeOver: true, kill: () => {}, waitMs: 300 });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain('did not stop');
  });

  test('a live pid that is not cedia is not taken for a run', () => {
    const other = Bun.spawn(['sleep', '5']);
    try {
      expect(isCediaProcess(other.pid)).toBe(false);
      expect(isCediaProcess(process.pid)).toBe(true);
    } finally {
      other.kill();
    }
  });

  test('e2e: a second -p --thread is refused while the first runs, and --take-over stops it and goes on (offline, faux)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-busy-e2e-'));
    const home = join(dir, '.home');
    Bun.spawnSync(['mkdir', '-p', home]);
    const script = (steps: unknown[]) => {
      const p = join(home, `script-${Math.random()}.json`);
      writeFileSync(p, JSON.stringify(steps));
      return p;
    };
    const env = (steps: unknown[]) => ({ ...process.env, CEDIA_FAUX_SCRIPT: script(steps), CEDIA_HOME: home });
    const args = (prompt: string, extra: string[] = []) => [BIN, '-m', 'faux', '-p', prompt, ...extra, '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json', '--cwd', dir];
    const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });

    const first = Bun.spawnSync(args('first'), { env: env([reply('one')]), stdin: 'ignore' });
    expect(first.exitCode).toBe(0);
    const thread = JSON.parse(first.stdout.toString()).thread as string;
    const s = new ThreadStore(threadsDir(home, projectKey(dir)));

    // A run that sits in a long command until it is stopped.
    const slow = Bun.spawn(args('slow', ['--thread', thread]), { env: env([{ blocks: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'sleep 30' } }] }, reply('slept')]), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const until = Date.now() + 15_000;
    while (Date.now() < until && !s.read(thread).running) await Bun.sleep(100);
    expect(s.read(thread).runs.at(-1)?.pid).toBe(slow.pid);

    const refused = Bun.spawnSync(args('second', ['--thread', thread]), { env: env([reply('two')]), stdin: 'ignore' });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain(`thread ${thread} is working`);
    expect(s.read(thread).runs).toHaveLength(2);

    const took = Bun.spawnSync(args('third', ['--thread', thread, '--take-over']), { env: env([reply('three')]), stdin: 'ignore' });
    expect(took.stderr.toString()).toContain(`stopped run`);
    expect(took.exitCode).toBe(0);
    await slow.exited;
    const t = s.read(thread);
    expect(t.runs.map((r) => r.prompt)).toEqual(['first', 'slow', 'third']);
    const states = s.events(thread).filter((e) => e.kind === 'state').map((e) => e.kind === 'state' && e.state);
    expect(states).toEqual(['done', 'stopped', 'done']);
    expect(t.result).toBe('three');
  }, 60_000);
});
