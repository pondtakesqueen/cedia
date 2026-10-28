import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
