import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadStore, threadsDir } from '../src/core/project/threads.ts';
import { projectKey, projectSlug, SessionLog, workspaceRoots } from '../src/core/session/log.ts';
import { openThreadTool } from '../src/core/tools/open.ts';
import type { SessionEvent } from '../src/core/types.ts';

// A multi-repo workspace (CEDIA_ROOTS, primary root first): one project key for every root, threads opened in a
// root run there, and the other roots are named to the writer as read-only.

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

function repo(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return realpathSync(dir);
}

function workspace() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cedia-ws-')));
  return { base, a: repo(base, 'app'), b: repo(base, 'lib'), other: repo(base, 'elsewhere') };
}

const saved = process.env.CEDIA_ROOTS;
afterEach(() => {
  if (saved === undefined) delete process.env.CEDIA_ROOTS;
  else process.env.CEDIA_ROOTS = saved;
});

describe('multi-repo workspace', () => {
  test('every root of a workspace is filed under the primary root, and a single root keeps its own key', () => {
    const { a, b, other } = workspace();
    delete process.env.CEDIA_ROOTS;
    expect(projectKey(b)).toBe(projectSlug(b));
    process.env.CEDIA_ROOTS = `${a}:${b}:${a}/`;
    expect(workspaceRoots()).toEqual([a, b]);
    expect(projectKey(b)).toBe(projectSlug(a));
    mkdirSync(join(b, 'src'));
    expect(projectKey(join(b, 'src'))).toBe(projectSlug(a));
    expect(projectKey(other)).toBe(projectSlug(other));
  });

  test('open_thread opens in a root of the workspace and refuses any other directory', async () => {
    const { base, a, b, other } = workspace();
    const store = new ThreadStore(join(base, 'threads'));
    const coordinator = store.open('coordinate');
    const tool = openThreadTool(store, coordinator, { count: 0 }, a, [a, b]);
    const refused = await tool.run({ task: 'fix it', root: other }, {} as never);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`${other} is not a root of this workspace`);
    const opened = await tool.run({ task: 'fix the parser', root: `${b}/` }, {} as never);
    expect(opened.isError).toBe(false);
    const id = /Opened thread (\S+)/.exec(opened.text)![1]!;
    expect(store.read(id).root).toBe(b);
  });

  test('a --thread run goes on in the thread\'s root and names the other roots as read-only', () => {
    const { base, a, b } = workspace();
    const home = join(base, 'home');
    const env = { ...process.env, CEDIA_HOME: home, CEDIA_ROOTS: `${a}:${b}`, CEDIA_FAUX_SCRIPT: join(base, 'script.json') };
    writeFileSync(join(base, 'script.json'), JSON.stringify([{ blocks: [{ type: 'text', text: 'done' }] }]));
    const store = new ThreadStore(threadsDir(home, projectSlug(a)));
    const id = store.open('fix the parser', { root: b });
    // The client starts cedia in the primary root; the thread was opened in the other one.
    const run = spawnSync(BIN, ['-m', 'faux', '--cwd', a, '-p', 'fix the parser', '--thread', id, '--output-format', 'json'], { env, encoding: 'utf8' });
    expect(JSON.parse(run.stdout).subtype).toBe('success');
    const sessions = join(home, 'sessions', projectSlug(a));
    const events = readdirSync(sessions).flatMap((f) => SessionLog.load(join(sessions, f)).events);
    const session = events.find((e) => e.kind === 'session') as Extract<SessionEvent, { kind: 'session' }>;
    expect(session.cwd).toBe(b);
    expect(JSON.stringify(events)).toContain(`other repositories of this workspace, to read only (a change there is another thread's work): ${a}`);
  });
});
