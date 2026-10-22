import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { protocolSchema } from '../scripts/protocol-schema.ts';
import { FIXTURES, record, SCENARIOS, type Recording } from '../scripts/session-fixtures.ts';
import { lintSession } from '../src/core/session/lint.ts';
import type { SessionEvent } from '../src/core/types.ts';
import { VERSION } from '../src/core/version.ts';

// The contract clients build on (the desktop generates its Rust types from the schema and replays the fixtures),
// so a change to either must be a deliberate regeneration, never drift.

const lines = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
// What a client branches on: message type and event kind, never ids or times.
const shapeOfLine = (l: Record<string, any>) => [l.type, l.kind, l.event?.kind, l.event?.type, l.subtype].filter(Boolean).join(':');
const shape = (r: Recording) => ({
  stream: lines(r.stream).map(shapeOfLine),
  threads: Object.values(r.threads).map((t) => lines(t).map(shapeOfLine)).sort(),
  sessions: Object.values(r.sessions).map((t) => lines(t).map(shapeOfLine)).sort(),
});
const committed = (name: string): Recording => {
  const dir = join(FIXTURES, name);
  const filesIn = (d: string) => Object.fromEntries(readdirSync(join(dir, d)).map((f) => [f, readFileSync(join(dir, d, f), 'utf8')]));
  return { stream: readFileSync(join(dir, 'stream.jsonl'), 'utf8'), threads: filesIn('threads'), sessions: filesIn('sessions') };
};

describe('client contract', () => {
  test('protocol.schema.json matches the protocol types (bun scripts/protocol-schema.ts)', () => {
    expect(readFileSync(join(import.meta.dir, '..', 'src', 'protocol', 'protocol.schema.json'), 'utf8')).toBe(protocolSchema());
  });

  test('cedia --version --json names the version, the hash of the schema it speaks, and its capabilities', () => {
    const run = (...args: string[]) => Bun.spawnSync([join(import.meta.dir, '..', 'bin', 'cedia'), ...args], { env: { ...process.env, CEDIA_KEYCHAIN: 'off' } }).stdout.toString();
    const info = JSON.parse(run('--version', '--json'));
    const schema = readFileSync(join(import.meta.dir, '..', 'src', 'protocol', 'protocol.schema.json'));
    expect(info).toEqual({ name: 'cedia', version: VERSION, protocol: new Bun.CryptoHasher('sha256').update(schema).digest('hex').slice(0, 16), capabilities: expect.arrayContaining(['threads.unsend', 'threads.rate', 'evidence.check-thread']) });
    expect(info.capabilities).not.toContain('keychain');
    expect(JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).version).toBe(VERSION);
    expect(run('--version')).toBe(`cedia ${VERSION}\n`);
  });

  test('the fixture index names every scenario', () => {
    expect(JSON.parse(readFileSync(join(FIXTURES, 'index.json'), 'utf8')).map((s: { name: string }) => s.name)).toEqual(SCENARIOS.map((s) => s.name));
  });

  for (const s of SCENARIOS) {
    test(`fixture ${s.name}: its sessions lint clean, its paths are normalized, and a fresh run has the same shape (bun scripts/session-fixtures.ts)`, () => {
      const c = committed(s.name);
      for (const text of Object.values(c.sessions)) expect(lintSession(lines(text) as SessionEvent[])).toEqual([]);
      for (const text of [c.stream, ...Object.values(c.threads), ...Object.values(c.sessions)]) expect(text).not.toMatch(/cedia-fixture-/);
      const fresh = record(s);
      expect(shape(fresh)).toEqual(shape(c));
      // Thread ids are numbered, not random, so a re-record keeps them.
      expect(Object.keys(fresh.threads).sort()).toEqual(Object.keys(c.threads).sort());
    });
  }
});
