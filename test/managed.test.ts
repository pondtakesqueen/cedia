import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
describe('managed remote poll (offline)', () => {
  const envOf = (home: string, extra: Record<string, string | undefined> = {}) => ({ ...process.env, CEDIA_HOME: home, ...extra });
  test('no URL: nothing cached, nothing fetched, never stale', async () => {
    const { mdmCacheStale, refreshMdmIfStale } = await import('../src/core/project/mdm-remote.ts');
    const home = mkdtempSync(join(tmpdir(), 'cedia-mdm-'));
    const env = envOf(home, { CEDIA_MDM_URL: undefined });
    expect(mdmCacheStale(home, Date.now(), env)).toBe(false);
    expect(await refreshMdmIfStale(home, env)).toBe('no-url');
  });
  test('missing cache is stale; a fetch writes it; a fresh cache is left alone', async () => {
    const { mdmCachePath, mdmCacheStale, refreshMdmIfStale, mdmPollMinutes } = await import('../src/core/project/mdm-remote.ts');
    let hits = 0;
    const http = Bun.serve({ port: 0, fetch: () => (hits++, Response.json({ permissions: { deny: ['Bash(curl *)'] } })) });
    try {
      const home = mkdtempSync(join(tmpdir(), 'cedia-mdm-'));
      const env = envOf(home, { CEDIA_MDM_URL: `http://localhost:${http.port}/managed` });
      expect(mdmPollMinutes(env)).toBe(60);
      expect(mdmPollMinutes({ ...env, CEDIA_MDM_POLL_MIN: '1' })).toBe(5);
      expect(mdmCacheStale(home, Date.now(), env)).toBe(true);
      expect(await refreshMdmIfStale(home, env)).toBe('refreshed');
      expect(hits).toBe(1);
      expect(JSON.parse(readFileSync(mdmCachePath(home), 'utf8'))).toEqual({ permissions: { deny: ['Bash(curl *)'] } });
      expect(mdmCacheStale(home, Date.now(), env)).toBe(false);
      expect(await refreshMdmIfStale(home, env)).toBe('fresh');
      expect(hits).toBe(1);
    } finally {
      http.stop(true);
    }
  });
  test('a dead endpoint fails open: stale stays, nothing throws', async () => {
    const { refreshMdmIfStale } = await import('../src/core/project/mdm-remote.ts');
    const home = mkdtempSync(join(tmpdir(), 'cedia-mdm-'));
    const env = envOf(home, { CEDIA_MDM_URL: 'http://localhost:1/managed' });
    expect(await refreshMdmIfStale(home, env)).toBe('failed');
  });
});
