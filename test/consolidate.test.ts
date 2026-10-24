import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { SessionLog } from '../src/core/session/log.ts';

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