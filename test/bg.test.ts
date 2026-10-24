import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

describe('background agents (offline)', () => {
  test('start/list/stop lifecycle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-bg-'));
    const home = join(dir, '.home');
    mkdirSync(home, { recursive: true });
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env, CEDIA_HOME: home };
    // init git
    Bun.spawnSync(['git', 'init'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t.com'], { cwd: repo });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: repo });
    Bun.spawnSync(['bash', '-c', 'echo hi > README.md && git add -A && git commit -m init'], { cwd: repo });
    const start = Bun.spawnSync([BIN, '--bg', '-p', 'hello', '--cwd', repo, '--sandbox', 'off'], { env });
    expect(start.exitCode).toBe(0);
    const id = start.stdout.toString().trim();
    expect(id).toMatch(/^bg-/);
    const list = Bun.spawnSync([BIN, 'agents', '--cwd', repo, '--json'], { env });
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain(id);
    Bun.spawnSync([BIN, 'stop', id, '--cwd', repo], { env });
    const list2 = Bun.spawnSync([BIN, 'agents', '--cwd', repo], { env });
    expect(list2.stdout.toString()).toContain('dead');
  });
});