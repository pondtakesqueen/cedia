import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrompt } from '../src/core/loop/run.ts';
import { FAUX_MODEL } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse } from '../src/core/providers/faux.ts';
import { decide } from '../src/core/safety/policy.ts';
import { openSandbox } from '../src/core/safety/sandbox.ts';
import { openSnapshots } from '../src/core/safety/snapshot.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool, scrubbedEnv } from '../src/core/tools/bash.ts';
import { writeTool } from '../src/core/tools/edit.ts';
import { CORE_TOOLS } from '../src/core/tools/index.ts';
import type { EventOf, SessionEvent } from '../src/core/types.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const of = <K extends SessionEvent['kind']>(events: SessionEvent[], k: K) => events.filter((e): e is EventOf<K> => e.kind === k);
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd }).stdout.toString();

describe('shadow-git snapshots', () => {
  test('name changed files, restore a tree, and leave the user repo alone', () => {
    const cwd = tmp('cedia-snap-');
    git(cwd, 'init', '-q');
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    writeFileSync(join(cwd, '.gitignore'), 'build/\n');
    const before = git(cwd, 'status', '--porcelain');
    const snaps = openSnapshots(cwd, join(tmp('cedia-snapdir-'), 'git'))!;
    const t0 = snaps.take()!;
    writeFileSync(join(cwd, 'a.txt'), 'changed\n');
    writeFileSync(join(cwd, 'b.txt'), 'new\n');
    mkdirSync(join(cwd, 'build'));
    writeFileSync(join(cwd, 'build', 'out.js'), 'ignored');
    const t1 = snaps.take()!;
    expect(snaps.diff(t0, t1).sort()).toEqual(['a.txt', 'b.txt']);
    // The user's repo has nothing staged and no index: the snapshots went to the shadow git dir.
    expect(git(cwd, 'ls-files')).toBe('');
    expect(existsSync(join(cwd, '.git', 'index'))).toBe(false);
    expect(before).toBe('?? .gitignore\n?? a.txt\n');
    snaps.restore(t0);
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a\n');
    expect(existsSync(join(cwd, 'b.txt'))).toBe(false);
    expect(existsSync(join(cwd, 'build', 'out.js'))).toBe(true);
  });

  test('excluded paths inside the working directory are never recorded', () => {
    const cwd = tmp('cedia-snapx-');
    const snaps = openSnapshots(cwd, join(cwd, 'home', 'snapshots'), [join(cwd, 'home')])!;
    const t0 = snaps.take()!;
    writeFileSync(join(cwd, 'home', 'log.jsonl'), '{}');
    writeFileSync(join(cwd, 'x.txt'), 'x');
    expect(snaps.diff(t0, snaps.take()!)).toEqual(['x.txt']);
  });

  test('the loop logs the files a bash call changed, and the receipt names them', async () => {
    const cwd = tmp('cedia-snaploop-');
    const log = SessionLog.create();
    const provider = fauxProvider([{ blocks: [toolUse('b1', 'bash', { command: 'mkdir -p src && echo x > src/gen.ts' }), toolUse('r1', 'bash', { command: 'ls' })] }, { blocks: [text('ok')] }]);
    const snapshots = openSnapshots(cwd, join(tmp('cedia-snapdir-'), 'git'))!;
    const res = await runPrompt({ log, provider, model: FAUX_MODEL, tools: CORE_TOOLS, system: 's', cwd, snapshots, permission: { mode: 'workspace', allow: [], deny: [] } }, 'go');
    expect(of(log.events, 'snapshot').map((s) => [s.callId, s.changed])).toEqual([[undefined, []], ['b1', ['src/gen.ts']]]);
    expect(res.evidence?.changed).toEqual(['src/gen.ts']);
    expect(lintSession(log.events)).toEqual([]);
  });
});

describe('bash environment and protected paths', () => {
  test('commands never see keys, tokens or cedia settings', () => {
    const env = scrubbedEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', OPENCODE_API_KEY: 'k', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', CEDIA_HOME: 'h', KEYBOARD: 'us', HOME: '/root' });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'KEYBOARD', 'PATH']);
  });

  test('edit and write never touch .git or .cedia', () => {
    const cwd = tmp('cedia-prot-');
    const ws = { mode: 'workspace' as const, allow: [], deny: [] };
    expect(decide(ws, writeTool, { path: '.git/hooks/pre-commit', content: '' }, cwd).rule).toBe('protected-path');
    expect(decide(ws, writeTool, { path: '.cedia/settings.json', content: '' }, cwd).rule).toBe('protected-path');
    expect(decide(ws, writeTool, { path: '.github/workflows/ci.yml', content: '' }, cwd).rule).toBe('mode:workspace');
  });
});

// Runs wherever the OS sandbox is available; CI sets CEDIA_REQUIRE_SANDBOX=1 so a missing sandbox fails there.
describe('OS sandbox', async () => {
  const cwd = tmp('cedia-sbx-');
  const opened = await openSandbox(cwd, process.env.CEDIA_REQUIRE_SANDBOX ? 'on' : 'auto', { allowedDomains: [], cediaHome: join(cwd, 'nohome') });
  const sb = opened.sandbox;
  const run = (command: string) => bashTool.run({ command }, { cwd, signal: new AbortController().signal, wrap: sb.wrap });

  test.if(sb.on)('writes inside the working directory and the temp dir only', async () => {
    expect((await run('echo ok > inside.txt && cat inside.txt')).text).toContain('ok');
    const outside = join(homedir(), `cedia-sbx-${Date.now()}.txt`);
    const r = await run(`echo no > ${outside}`);
    expect(r.isError).toBe(true);
    expect(existsSync(outside)).toBe(false);
    rmSync(outside, { force: true });
  });

  test.if(sb.on)('no network to hosts that are not allowed', async () => {
    const r = await run('curl -sS -m 5 https://example.com -o /dev/null');
    expect(r.isError).toBe(true);
  });

  test.if(sb.on)('snapshots taken while it is up see only real changes, not its placeholders', async () => {
    const snaps = openSnapshots(cwd, join(tmp('cedia-snapdir-'), 'git'), sb.placeholders)!;
    const t0 = snaps.take()!;
    await run('echo real > real.txt');
    expect(snaps.diff(t0, snaps.take()!)).toEqual(['real.txt']);
  });

  test.if(sb.on)('closes', async () => {
    await sb.close();
  });
});
