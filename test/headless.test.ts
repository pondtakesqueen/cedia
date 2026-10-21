import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeMisses } from '../src/core/context/cache.ts';
import { resolveModel } from '../src/core/providers/catalog.ts';
import { authHeaders, missingKeyNote } from '../src/core/providers/http.ts';
import { SessionLog } from '../src/core/session/log.ts';
import type { SessionEvent } from '../src/core/types.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

function cedia(script: unknown[], args: string[], stdin?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-e2e-'));
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(script));
  const home = join(dir, 'home');
  const proc = Bun.spawnSync([BIN, '-m', 'faux', '--cwd', dir, ...args], {
    env: { ...process.env, CEDIA_FAUX_SCRIPT: scriptPath, CEDIA_HOME: home },
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString(), home, dir };
}

const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });
const call = (id: string, command: string) => ({ blocks: [{ type: 'tool_use', id, name: 'bash', input: { command } }] });

describe('cedia -p (offline, faux)', () => {
  test('text output, exit 0, session written under CEDIA_HOME', () => {
    const r = cedia([call('c1', 'ls'), reply('all good')], ['-p', 'check']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('all good\n');
    const sessions = join(r.home, 'sessions');
    const [project] = readdirSync(sessions);
    const [file] = readdirSync(join(sessions, project!));
    const log = SessionLog.load(join(sessions, project!, file!));
    expect(log.events.map((e) => e.kind)).toContain('tool_result');
  });

  test('prompt from stdin', () => {
    expect(cedia([reply('from stdin')], [], 'hello').out).toBe('from stdin\n');
  });

  test('json result and exit 1 on max turns', () => {
    const r = cedia([call('c1', 'ls'), call('c2', 'ls'), reply('x')], ['-p', 'go', '--output-format', 'json', '--max-turns', '1']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ type: 'result', subtype: 'error_max_turns', numTurns: 1 });
  });

  test('stream-json emits events, stream deltas and one result', () => {
    const r = cedia([reply('streamed')], ['-p', 'go', '--output-format', 'stream-json']);
    const lines = r.out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'streamed' });
    expect(lines.some((l) => l.type === 'stream' && l.event.type === 'text_delta')).toBe(true);
    expect(lines.filter((l) => l.type === 'event').map((l) => l.event.kind)).toEqual(['session', 'reminder', 'user', 'request', 'attempt', 'assistant', 'turn_end']);
  });

  test('a missing key is a note, since a proxy may add credentials; the alternate name counts', () => {
    expect(missingKeyNote(resolveModel('opus'), {})).toContain('ANTHROPIC_API_KEY (or CEDIA_ANTHROPIC_API_KEY) is not set');
    expect(missingKeyNote(resolveModel('opus'), { ANTHROPIC_API_KEY: 'k' })).toBeUndefined();
    expect(missingKeyNote(resolveModel('opus'), { CEDIA_ANTHROPIC_API_KEY: 'k' })).toBeUndefined();
    expect(authHeaders(resolveModel('opus'), { CEDIA_ANTHROPIC_API_KEY: 'alt' })).toEqual({ 'x-api-key': 'alt' });
    expect(authHeaders(resolveModel('opus'), { ANTHROPIC_API_KEY: 'main', CEDIA_ANTHROPIC_API_KEY: 'alt' })).toEqual({ 'x-api-key': 'main' });
    expect(missingKeyNote(resolveModel('faux'), {})).toBeUndefined();
  });
});

describe('miss attribution', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 0, 0, s)).toISOString();
  const req = (s: number, systemHash = 's', toolsHash = 't') =>
    ({ id: `r${s}`, parentId: null, at: at(s), kind: 'request', model: 'm', toolsHash, systemHash, bodyHash: "b", headers: {} }) as unknown as SessionEvent;
  const asst = (s: number, cacheRead: number, uncached: number) =>
    ({ id: `a${s}`, parentId: null, at: at(s), kind: 'assistant', wire: 'faux', model: 'm', blocks: [], stop: 'end_turn', usage: { uncached, cacheRead, cacheWrite: 0, output: 1 } }) as unknown as SessionEvent;

  test('names the cause of each miss from the log', () => {
    const rows = attributeMisses([
      req(0), asst(1, 0, 1000),
      req(2), asst(3, 1000, 100),
      req(4, 'changed'), asst(5, 0, 1200),
      req(400, 'changed'), asst(401, 0, 1300),
      req(402, 'changed'), asst(403, 100, 1300),
    ]);
    expect(rows.map((r) => r.cause)).toEqual(['cold', undefined, 'system_changed', 'idle_over_ttl', 'provider']);
  });
});
