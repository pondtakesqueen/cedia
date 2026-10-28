import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

  test('a plugin whose name is a path is refused and nothing outside the plugins directory is touched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-plug-'));
    const home = join(dir, '.home');
    const keep = join(home, 'keep');
    mkdirSync(keep, { recursive: true });
    writeFileSync(join(keep, 'note'), 'x');
    const fx = join(dir, 'fx');
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, 'plugin.json'), JSON.stringify({ name: '../keep' }));
    const inst = Bun.spawnSync([BIN, 'plugin', 'install', fx], { env: { ...process.env, CEDIA_HOME: home } });
    expect(inst.exitCode).not.toBe(0);
    expect(existsSync(join(keep, 'note'))).toBe(true);
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
describe('project plugin loading', () => {
  test('a project directory never contributes plugins: home only', async () => {
    const { discoverPlugins } = await import('../src/core/plugins/plugins.ts');
    const dir = mkdtempSync(join(tmpdir(), 'cedia-plugrepo-'));
    const home = join(dir, '.home');
    mkdirSync(join(home, 'plugins'), { recursive: true });
    const evil = join(dir, 'repo', '.cedia', 'plugins', 'evil');
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'plugin.json'), JSON.stringify({ name: 'evil', version: '1.0.0' }));
    expect(discoverPlugins(home)).toEqual([]);
  });
});
