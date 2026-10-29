import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { scanTranscripts } from '../src/core/project/consolidate.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

describe('memory consolidate (offline, faux)', () => {
  test('scans a session and keeps a note', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-cons-'));
    const home = join(dir, '.home');
    const run = (script: unknown[], args: string[]) => {
      const sp = join(dir, `.s-${Math.random()}.json`);
      writeFileSync(sp, JSON.stringify(script));
      const p = Bun.spawnSync([BIN, ...args, '--cwd', dir], { env: { ...process.env, CEDIA_FAUX_SCRIPT: sp, CEDIA_HOME: home } });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    // A first run that leaves a session transcript.
    expect(run([{ blocks: [{ type: 'text', text: 'ok' }] }], ['-m', 'faux', '-p', 'hello', '--permission', 'workspace', '--sandbox', 'off']).code).toBe(0);
    // Consolidation keeps a note via the remember tool.
    expect(run([{ blocks: [{ type: 'tool_use', id: 'c1', name: 'remember', input: { note: 'tests run with bun test' } }] }, { blocks: [{ type: 'text', text: 'done' }] }], ['memory', 'consolidate']).code).toBe(0);
    const listed = run([], ['memory', 'list']);
    expect(listed.out).toContain('tests run with bun test');
    // lock file exists
    const sessions = join(home, 'sessions');
    const [project] = readdirSync(sessions);
    expect(project).toBeTruthy();
  });
});
describe('memory transcript scan', () => {
  const write = (dir: string, name: string, events: unknown[], mtime: number) => {
    const p = join(dir, `${name}.jsonl`);
    writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    utimesSync(p, mtime, mtime);
  };
  const session = (role: string, text: string) => [
    { kind: 'session', role },
    { kind: 'user', text },
    { kind: 'assistant', blocks: [{ type: 'text', text: `${text} done` }] },
  ];

  test("reads the newest writer sessions, oldest first, and leaves other roles' sessions out", () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-scan-'));
    const dir = join(home, 'sessions', 'p');
    mkdirSync(dir, { recursive: true });
    write(dir, 'old', session('code', 'old work ' + 'x'.repeat(300)), 1_000);
    write(dir, 'mid', session('code', 'mid work'), 2_000);
    write(dir, 'side', session('consolidate', 'a memory pass'), 3_000);
    write(dir, 'new', session('code', 'new work'), 4_000);
    write(dir, 'complete', session('complete', 'a tab completion'), 5_000);
    const all = scanTranscripts(home, 'p');
    expect(all.count).toBe(3);
    expect(all.text).not.toContain('a memory pass');
    expect(all.text).not.toContain('a tab completion');
    expect(all.text.indexOf('old work')).toBeLessThan(all.text.indexOf('mid work'));
    expect(all.text.indexOf('mid work')).toBeLessThan(all.text.indexOf('new work'));
    // A cap that fits two sessions keeps the newest two, not the oldest.
    const two = scanTranscripts(home, 'p', 150);
    expect(two.count).toBe(2);
    expect(two.text).toContain('new work');
    expect(two.text).toContain('mid work');
    expect(two.text).not.toContain('old work');
  });

  test('a consolidation is logged as a session of its own: usage counts it and the next scan skips it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-cons-log-'));
    const home = join(dir, '.home');
    const run = (script: unknown[], args: string[]) => {
      const sp = join(dir, `.s-${Math.random()}.json`);
      writeFileSync(sp, JSON.stringify(script));
      const p = Bun.spawnSync([BIN, ...args, '--cwd', dir], { env: { ...process.env, CEDIA_FAUX_SCRIPT: sp, CEDIA_HOME: home } });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    expect(run([{ blocks: [{ type: 'text', text: 'ok' }] }], ['-m', 'faux', '-p', 'hello', '--permission', 'workspace', '--sandbox', 'off']).code).toBe(0);
    const [project] = readdirSync(join(home, 'sessions'));
    const sessions = () => readdirSync(join(home, 'sessions', project!)).filter((f) => f.endsWith('.jsonl'));
    expect(sessions()).toHaveLength(1);
    expect(run([{ blocks: [{ type: 'text', text: 'nothing durable' }] }], ['memory', 'consolidate']).code).toBe(0);
    expect(sessions()).toHaveLength(2);
    const roles = sessions().map((f) => JSON.parse(readFileSync(join(home, 'sessions', project!, f), 'utf8').split('\n')[0]!).role);
    expect(roles.sort()).toEqual(['code', 'consolidate']);
    const usage = run([], ['usage', '--json']);
    expect(usage.code).toBe(0);
    expect(JSON.parse(usage.out).sessions).toBe(2);
    expect(scanTranscripts(home, project!).count).toBe(1);
  });
});
