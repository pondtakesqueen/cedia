import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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

  test('auto is read-only without the sandbox; --permission workspace lets a command write', () => {
    const script = [call('c1', 'echo hi > out.txt'), reply('done')];
    const ro = cedia(script, ['-p', 'write it', '--output-format', 'json', '--sandbox', 'off']);
    expect(existsSync(join(ro.dir, 'out.txt'))).toBe(false);
    expect(ro.err).toContain('the sandbox is off, so this session is read-only');
    const ws = cedia(script, ['-p', 'write it', '--permission', 'workspace', '--sandbox', 'off']);
    expect(ws.code).toBe(0);
    expect(existsSync(join(ws.dir, 'out.txt'))).toBe(true);
    expect(cedia(script, ['-p', 'x', '--permission', 'yolo']).err).toContain('unknown permission mode');
    expect(cedia(script, ['-p', 'x', '--unlock', 'everything']).err).toContain('unknown guard');
  });

  // CI sets CEDIA_REQUIRE_SANDBOX=1; elsewhere this runs only where the sandbox opens.
  test.skipIf(!process.env.CEDIA_REQUIRE_SANDBOX && !Bun.which('bwrap') && process.platform !== 'darwin')('auto is workspace inside the sandbox, with no prompt', () => {
    const r = cedia([call('c1', 'echo hi > out.txt'), reply('done')], ['-p', 'write it', '--sandbox', 'on']);
    expect(r.code).toBe(0);
    expect(existsSync(join(r.dir, 'out.txt'))).toBe(true);
  });

  test('--check gates the claim, the receipt goes to stderr, and lint-session passes the log', () => {
    const script = [call('c1', 'echo hi > out.txt'), call('c2', 'test -f out.txt'), reply('done')];
    const r = cedia(script, ['-p', 'make it', '--permission', 'workspace', '--check', 'test -f out.txt']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('cedia receipt: changed out.txt; checks test -f out.txt (exit 0); unverified none');
    const sessions = join(r.home, 'sessions');
    const [project] = readdirSync(sessions);
    const file = join(sessions, project!, readdirSync(join(sessions, project!))[0]!);
    const lint = Bun.spawnSync([BIN, 'lint-session', file]);
    expect(lint.stdout.toString()).toBe('');
    expect(lint.exitCode).toBe(0);

    const unchecked = cedia([call('c1', 'echo hi > out.txt'), reply('done'), reply('done')], ['-p', 'make it', '--permission', 'workspace', '--check', 'test -f out.txt']);
    expect(unchecked.code).toBe(1);
    expect(unchecked.err).toContain('error_unverified_claim');
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

  test('a spent quota continues in a new session on the fallback, which must still verify the first one\'s changes', () => {
    const quota = { error: { code: 'quota', status: 402, message: 'Insufficient Balance' } };
    const args = ['-p', 'make f.txt say good', '--output-format', 'json', '--permission', 'workspace', '--sandbox', 'off', '--check', 'grep -q good f.txt', '--fallback', 'faux/fallback'];
    const sessions = (home: string) => {
      const root = join(home, 'sessions');
      const [project] = readdirSync(root);
      return readdirSync(join(root, project!)).map((f) => ({ id: f.replace(/\.jsonl$/, ''), events: SessionLog.load(join(root, project!, f)).events }));
    };
    const head = (events: SessionEvent[]) => events[0] as Extract<SessionEvent, { kind: 'session' }>;

    // The fallback session claims done without a check: the first session's write still needs one.
    const lazy = cedia([call('c1', 'echo good > f.txt'), quota, reply('done'), reply('done')], args);
    expect(JSON.parse(lazy.out)).toMatchObject({ subtype: 'error_unverified_claim', evidence: { changed: ['f.txt'], unverified: ['f.txt'] } });
    expect(lazy.err).toContain('faux/scripted is out of quota; continuing on faux/fallback in a new session');

    const ok = cedia([call('c1', 'echo good > f.txt'), quota, call('c2', 'grep -q good f.txt'), reply('done')], args);
    const result = JSON.parse(ok.out);
    expect(result).toMatchObject({ subtype: 'success', numTurns: 4, evidence: { changed: ['f.txt'], unverified: [] } });
    const logs = sessions(ok.home);
    expect(logs).toHaveLength(2);
    const second = logs.find((l) => head(l.events).parentSession)!;
    const first = logs.find((l) => l !== second)!;
    expect(head(first.events).model).toBe('faux/scripted');
    expect(head(second.events)).toMatchObject({ model: 'faux/fallback', parentSession: first.id });
    expect(result.sessionId).toBe(second.id);
    // The model learns about the hand-over from a logged reminder, not from anything unlogged.
    expect(second.events.some((e) => e.kind === 'reminder' && e.text.includes('stopped partway through this task when its quota ran out'))).toBe(true);
  });

  describe('--review', () => {
    const args = ['-p', 'make f.txt say good', '--output-format', 'json', '--permission', 'workspace', '--sandbox', 'off', '--check', 'test -s f.txt', '--review', 'faux/fallback'];
    const writes = [call('c1', 'echo good > f.txt'), call('c2', 'test -s f.txt'), reply('done')];
    const logs = (home: string) => {
      const root = join(home, 'sessions');
      const [project] = readdirSync(root);
      return readdirSync(join(root, project!)).map((f) => SessionLog.load(join(root, project!, f)).events);
    };
    const head = (events: SessionEvent[]) => events[0] as Extract<SessionEvent, { kind: 'session' }>;

    test('an approving review leaves the change as it is and adds its spend', () => {
      const r = cedia([...writes, call('r1', 'cat f.txt'), reply('f.txt holds the asked text.\nVERDICT: approve')], args);
      const result = JSON.parse(r.out);
      expect(result).toMatchObject({ subtype: 'success', numTurns: 5, result: 'done', review: { model: 'faux/fallback', verdict: 'approve', fixed: false } });
      const review = logs(r.home).find((l) => head(l).role === 'review')!;
      expect(head(review).tools.map((t) => t.name)).toEqual(['read', 'bash']);
      const prompt = review.find((e): e is Extract<SessionEvent, { kind: 'user' }> => e.kind === 'user')!.text;
      expect(prompt).toContain('make f.txt say good');
      expect(prompt).toContain('+good'); // the writer's diff, from its snapshots
    });

    test('requested changes go back to the writer session once; the reviewer cannot write', () => {
      const r = cedia(
        [...writes, call('r1', 'echo hacked > g.txt'), reply('f.txt:1 should end with a period.\nVERDICT: changes'), call('c3', 'echo good. > f.txt'), call('c4', 'test -s f.txt'), reply('fixed')],
        args,
      );
      const result = JSON.parse(r.out);
      expect(result).toMatchObject({ subtype: 'success', result: 'fixed', review: { verdict: 'changes', fixed: true }, evidence: { changed: ['f.txt'], unverified: [] } });
      expect(existsSync(join(r.dir, 'g.txt'))).toBe(false);
      const all = logs(r.home);
      expect(all).toHaveLength(2);
      const writer = all.find((l) => head(l).role !== 'review')!;
      const asks = writer.filter((e): e is Extract<SessionEvent, { kind: 'user' }> => e.kind === 'user');
      expect(asks).toHaveLength(2);
      expect(asks[1]!.text).toContain('<review>\nf.txt:1 should end with a period.\n</review>');
    });

    test('no review when the writer did not succeed or changed nothing', () => {
      const r = cedia([call('c1', 'ls'), reply('nothing to do')], args);
      expect(JSON.parse(r.out).review).toBeUndefined();
    });
  });

  test('the DeepSeek API fallback is refused in a repo not marked public', () => {
    const r = cedia([{ error: { code: 'quota', status: 429, message: 'usage limit reached' } }], ['-p', 'x', '--output-format', 'json', '--fallback', 'deepseek-api']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).result).toContain('deepseek/deepseek-v4.1-flash trains on prompts');
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

  test('a read short of the previous input by less than one cache block is not a miss', () => {
    const rows = attributeMisses([req(0), asst(1, 0, 723), req(2), asst(3, 640, 170), req(4), asst(5, 640, 856)], { blockTokens: 128 });
    expect(rows.map((r) => r.cause)).toEqual(['cold', undefined, 'provider']);
    expect(rows[1]!.reusable).toBe(640);
  });
});
