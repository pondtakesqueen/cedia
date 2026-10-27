import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorReport } from '../src/core/doctor.ts';

const home = () => {
  const h = mkdtempSync(join(tmpdir(), 'cedia-doctor-'));
  mkdirSync(h, { recursive: true });
  return h;
};

describe('doctor report', () => {
  test('versions, sandbox shape, and absent tiers on a fresh home', () => {
    const h = home();
    const prev = process.env.CEDIA_HOME;
    process.env.CEDIA_HOME = h;
    try {
      const r = doctorReport('/tmp', h);
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof r.protocol).toBe('string');
      expect(typeof r.bun).toBe('string');
      expect(r.settings.user).toEqual({ present: false, ok: true });
      expect(r.settings.managed).toEqual({ present: false, ok: true });
      expect(r.settings.resolved).toBe('ok');
      expect(r.mdm).toEqual({ url: false, cache: 'missing' });
      expect(typeof r.sandbox.available).toBe('boolean');
      expect(r.mcp.servers).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CEDIA_HOME;
      else process.env.CEDIA_HOME = prev;
    }
  });

  test('user settings tier: ok, then an error on invalid JSON', () => {
    const h = home();
    writeFileSync(join(h, 'settings.json'), JSON.stringify({ permissions: { mode: 'workspace' } }));
    expect(doctorReport('/tmp', h).settings.user).toEqual({ present: true, ok: true });
    writeFileSync(join(h, 'settings.json'), '{nope');
    const bad = doctorReport('/tmp', h).settings.user;
    expect(bad.present).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('settings.json');
  });

  test('managed tier and mdm cache freshness', () => {
    const h = home();
    const prevManaged = process.env.CEDIA_MANAGED_DIR;
    const prevUrl = process.env.CEDIA_MDM_URL;
    process.env.CEDIA_MANAGED_DIR = join(h, 'managed');
    mkdirSync(join(h, 'managed'), { recursive: true });
    writeFileSync(join(h, 'managed', 'managed-settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }));
    try {
      expect(doctorReport('/tmp', h).settings.managed).toEqual({ present: true, ok: true });
      process.env.CEDIA_MDM_URL = 'http://localhost:1/managed';
      const cacheDir = join(h, 'mdm-cache');
      mkdirSync(cacheDir, { recursive: true });
      const cache = join(cacheDir, 'managed-settings.json');
      writeFileSync(cache, JSON.stringify({}));
      expect(doctorReport('/tmp', h).mdm).toEqual({ url: true, cache: 'fresh' });
      utimesSync(cache, new Date(2020, 0, 1), new Date(2020, 0, 1));
      expect(doctorReport('/tmp', h).mdm.cache).toBe('stale');
    } finally {
      if (prevManaged === undefined) delete process.env.CEDIA_MANAGED_DIR;
      else process.env.CEDIA_MANAGED_DIR = prevManaged;
      if (prevUrl === undefined) delete process.env.CEDIA_MDM_URL;
      else process.env.CEDIA_MDM_URL = prevUrl;
    }
  });

  test('mcp servers list names; invalid entries carry their error', () => {
    const h = home();
    const prev = process.env.CEDIA_HOME;
    process.env.CEDIA_HOME = h;
    try {
      writeFileSync(join(h, 'settings.json'), JSON.stringify({ mcpServers: { bad: { nope: 1 }, web: { url: 'http://localhost:1/x' } } }));
      const servers = doctorReport('/tmp', h).mcp.servers;
      expect(servers.map((s) => s.name)).toEqual(['bad', 'web']);
      expect(servers.find((s) => s.name === 'bad')?.error).toBeTruthy();
      expect(servers.find((s) => s.name === 'web')?.error).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CEDIA_HOME;
      else process.env.CEDIA_HOME = prev;
    }
  });
});
