import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadStore, threadsDir } from '../src/core/project/threads.ts';
import { projectKey } from '../src/core/session/log.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });

test("a thread's next run with no -m goes on with its writer's model, and -m still picks another", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-thread-model-'));
  const home = join(dir, '.home');
  const run = (args: string[]) => {
    const script = join(dir, `script-${Math.random()}.json`);
    writeFileSync(script, JSON.stringify([reply('done')]));
    const p = Bun.spawnSync([BIN, '--cwd', dir, '--output-format', 'json', ...args], { env: { ...process.env, CEDIA_FAUX_SCRIPT: script, CEDIA_HOME: home }, stdin: 'ignore' });
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString()) as { thread: string };
  };
  const { thread } = run(['-m', 'faux/fallback', '-p', 'start']);
  // The desktop sends the thread's next run as the person's message alone, with no model.
  run(['-p', 'go on', '--thread', thread]);
  run(['-m', 'faux', '-p', 'now on another', '--thread', thread]);
  const sessions = new ThreadStore(threadsDir(home, projectKey(dir))).read(thread).sessions.filter((s) => s.role === 'code');
  expect(sessions.map((s) => s.model)).toEqual(['faux/fallback', 'faux/fallback', 'faux/scripted']);
});
