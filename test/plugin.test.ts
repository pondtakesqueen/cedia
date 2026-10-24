import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

describe('plugins (offline)', () => {
  test('install/enable/disable/uninstall lifecycle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-plug-'));
    const home = join(dir, '.home');
    mkdirSync(home, { recursive: true });
    const fx = join(dir, 'fx');
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0', commands: ['hello'] }));
    const env = { ...process.env, CEDIA_HOME: home };
    const inst = Bun.spawnSync([BIN, 'plugin', 'install', fx], { env });
    expect(inst.exitCode).toBe(0);
    const listed = Bun.spawnSync([BIN, 'plugin', 'list', '--json'], { env });
    expect(JSON.parse(listed.stdout.toString()).length).toBe(1);
    Bun.spawnSync([BIN, 'plugin', 'disable', 'demo'], { env });
    const listed2 = Bun.spawnSync([BIN, 'plugin', 'list'], { env });
    expect(listed2.stdout.toString()).toContain(' demo@');
    Bun.spawnSync([BIN, 'plugin', 'uninstall', 'demo'], { env });
    const listed3 = Bun.spawnSync([BIN, 'plugin', 'list'], { env });
    expect(listed3.stdout.toString()).toContain('no plugins');
  });

  test('marketplace add/list/remove', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-mkt-'));
    const home = join(dir, '.home');
    mkdirSync(home, { recursive: true });
    const env = { ...process.env, CEDIA_HOME: home };
    Bun.spawnSync([BIN, 'marketplace', 'add', 'local', '/tmp/src'], { env });
    const l = Bun.spawnSync([BIN, 'marketplace', 'list', '--json'], { env });
    expect(JSON.parse(l.stdout.toString()).length).toBe(1);
    Bun.spawnSync([BIN, 'marketplace', 'remove', 'local'], { env });
    const l2 = Bun.spawnSync([BIN, 'marketplace', 'list'], { env });
    expect(l2.stdout.toString()).toContain('no marketplaces');
  });
});