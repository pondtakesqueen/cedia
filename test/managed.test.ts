import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

describe('managed settings (offline)', () => {
  test('resolution order unions deny arrays; policy limits cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-mgd-'));
    const home = join(dir, '.home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }));
    const mdir = join(dir, 'managed');
    mkdirSync(mdir, { recursive: true });
    writeFileSync(join(mdir, 'managed-settings.json'), JSON.stringify({ permissions: { deny: ['Bash(curl *)'] } }));
    const env = { ...process.env, CEDIA_HOME: home, CEDIA_MANAGED_DIR: mdir };
    const r = Bun.spawnSync([BIN, 'settings', '--source', 'resolved', '--json'], { env });
    expect(r.exitCode).toBe(0);
    const data = JSON.parse(r.stdout.toString());
    expect(data.permissions.deny).toContain('Bash(rm *)');
    expect(data.permissions.deny).toContain('Bash(curl *)');

    const p = Bun.spawnSync([BIN, 'policy-limits', '--write', '{"allowed":true}'], { env });
    expect(p.exitCode).toBe(0);
    const c = Bun.spawnSync([BIN, 'policy-limits', '--json'], { env });
    expect(JSON.parse(c.stdout.toString())).toEqual({ allowed: true });
  });
});