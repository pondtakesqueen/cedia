import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnosticsText, findCommand, lspServers, openDiagnoser, type LspServer } from '../src/core/lsp/diagnose.ts';
import { loadLsp } from '../src/core/config.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { scrubbedEnv } from '../src/core/tools/bash.ts';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-lsp.ts');
const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const fake = (extra: string[] = []): LspServer => ({ name: 'fake', command: [process.execPath, FAKE, ...extra], extensions: ['.txt'] });

describe('diagnostics after an edit', () => {
  test("a file's errors come back by line, warnings left out; a clean file and a file no server covers give nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-lsp-'));
    const d = openDiagnoser(cwd, [fake()], { env: scrubbedEnv() });
    try {
      writeFileSync(join(cwd, 'a.txt'), 'fine\nhere ERR\nWARN only\n');
      expect(await d.diagnose(join(cwd, 'a.txt'))).toBe('fake reports 1 error in a.txt as it is now:\n  2:6 bad thing on line 2 [E1]');
      // The same file again, changed: it is opened afresh (this server, like typescript-language-server, says
      // nothing on a change that keeps its diagnostics), and the new state is what comes back.
      writeFileSync(join(cwd, 'a.txt'), 'all fine\n');
      expect(await d.diagnose(join(cwd, 'a.txt'))).toBeUndefined();
      writeFileSync(join(cwd, 'b.md'), 'ERR\n');
      expect(await d.diagnose(join(cwd, 'b.md'))).toBeUndefined();
    } finally {
      await d.close();
    }
  });

  test('more than ten errors are counted, not listed; a server that does not start is reported once and skipped', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ range: { start: { line: i, character: 0 } }, severity: 1, message: `e${i}` }));
    const text = diagnosticsText('x.ts', 'ts', many)!;
    expect(text).toContain('ts reports 12 errors in x.ts');
    expect(text).toContain('  10:1 e9');
    expect(text).not.toContain('e10');
    expect(text).toEndWith('  and 2 more');

    const cwd = mkdtempSync(join(tmpdir(), 'cedia-lsp-'));
    const warned: string[] = [];
    const d = openDiagnoser(cwd, [{ name: 'broken', command: ['false'], extensions: ['.txt'] }], { env: scrubbedEnv(), warn: (l) => warned.push(l) });
    writeFileSync(join(cwd, 'a.txt'), 'ERR\n');
    expect(await d.diagnose(join(cwd, 'a.txt'))).toBeUndefined();
    expect(await d.diagnose(join(cwd, 'a.txt'))).toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('the broken language server did not start');
    await d.close();
  });

  test('a clean file comes back clean at once each time, however its path is encoded; a slow second step is waited for', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-lsp-'));
    mkdirSync(join(cwd, 'at@x'));
    const file = join(cwd, 'at@x', 'a.txt');
    const d = openDiagnoser(cwd, [fake(['--encode'])], { env: scrubbedEnv() });
    try {
      for (const text of ['fine\n', 'still fine\n', 'fine again\n']) {
        writeFileSync(file, text);
        const t = Date.now();
        expect(await d.diagnose(file)).toBeUndefined();
        expect(Date.now() - t).toBeLessThan(1_500);
      }
      writeFileSync(file, 'ERR\n');
      expect(await d.diagnose(file)).toContain('1 error in at@x/a.txt');
    } finally {
      await d.close();
    }
    const slow = openDiagnoser(cwd, [fake(['--late', '400'])], { env: scrubbedEnv() });
    try {
      writeFileSync(join(cwd, 'b.txt'), 'ERR one\n');
      expect(await slow.diagnose(join(cwd, 'b.txt'))).toContain('1 error in b.txt');
      // Its late step for the old text, if any, is not read as the new text's.
      writeFileSync(join(cwd, 'b.txt'), 'all fine now\n');
      expect(await slow.diagnose(join(cwd, 'b.txt'))).toBeUndefined();
    } finally {
      await slow.close();
    }
  });

  test('an abort stops the wait, a server still starting is not waited for, and closing stops it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-lsp-'));
    writeFileSync(join(cwd, 'a.txt'), 'ERR\n');
    const silent = openDiagnoser(cwd, [fake(['--silent'])], { env: scrubbedEnv() });
    let t = Date.now();
    expect(await silent.diagnose(join(cwd, 'a.txt'), AbortSignal.timeout(300))).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(1_500);
    await silent.close();

    const pidfile = join(cwd, 'pid');
    const stuck = openDiagnoser(cwd, [fake(['--init-delay', '600000', '--pidfile', pidfile])], { env: scrubbedEnv() });
    t = Date.now();
    expect(await stuck.diagnose(join(cwd, 'a.txt'), AbortSignal.timeout(300))).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(1_500);
    await stuck.close();
    expect(Date.now() - t).toBeLessThan(3_000);
    const pid = Number(require('node:fs').readFileSync(pidfile, 'utf8'));
    await Bun.sleep(100);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test('servers: the known ones found on PATH or in node_modules/.bin, the user\'s own beside them, none when off', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-lsp-'));
    mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', '.bin', 'typescript-language-server'), '');
    expect(findCommand('typescript-language-server', cwd, '')).toBe(join(cwd, 'node_modules', '.bin', 'typescript-language-server'));
    const found = lspServers(cwd, { mine: { command: [process.execPath, 'x'], extensions: ['.foo'] } });
    expect(found.map((s) => s.name)).toContain('typescript');
    expect(found.find((s) => s.name === 'mine')?.extensions).toEqual(['.foo']);
    expect(lspServers(cwd, false)).toEqual([]);
  });

  test('the setting: on or off by flag, false or servers in settings, and a malformed server is an error', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-home-'));
    const prev = process.env.CEDIA_HOME;
    process.env.CEDIA_HOME = home;
    try {
      expect(loadLsp()).toBeUndefined();
      expect(loadLsp('off')).toBe(false);
      expect(() => loadLsp('maybe')).toThrow('--lsp must be on or off');
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ lsp: false }));
      expect(loadLsp()).toBe(false);
      expect(loadLsp('on')).toBe(true);
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ lsp: { x: { command: 'x', extensions: ['.x'] } } }));
      expect(() => loadLsp()).toThrow('lsp.x must be');
    } finally {
      if (prev === undefined) delete process.env.CEDIA_HOME;
      else process.env.CEDIA_HOME = prev;
    }
  });
});

function run(settings: object, script: unknown[], args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-lsp-e2e-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings));
  const work = join(dir, 'work');
  mkdirSync(work);
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
  const p = Bun.spawnSync([BIN, '-m', 'faux', '--cwd', work, '--permission', 'workspace', '--output-format', 'json', ...args], {
    env: { ...process.env, CEDIA_FAUX_SCRIPT: join(dir, 'script.json'), CEDIA_HOME: home },
    stdin: 'ignore',
  });
  const out = JSON.parse(p.stdout.toString());
  const log = SessionLog.load(join(home, 'sessions', require('../src/core/session/log.ts').projectSlug(work), `${out.sessionId}.jsonl`));
  const result = (id: string) => log.events.find((e) => e.kind === 'tool_result' && e.callId === id) as { output: { text: string; isError: boolean } } | undefined;
  return { dir, work, out, result, err: p.stderr.toString() };
}

const write = (id: string, path: string, content: string) => ({ blocks: [{ type: 'tool_use', id, name: 'write', input: { path, content } }] });
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });

describe('cedia -p with a language server (offline, faux)', () => {
  test('the write result carries the errors, in the session log; --lsp off leaves them out', () => {
    const settings = { lsp: { fake: { command: [process.execPath, FAKE], extensions: ['.txt'] } } };
    const script = [write('w1', 'a.txt', 'ok\nERR here\n'), reply('done')];
    const on = run(settings, script, ['-p', 'write it', '--sandbox', 'off']);
    expect(on.result('w1')!.output.text).toBe('created a.txt (2 lines)\n\nfake reports 1 error in a.txt as it is now:\n  2:1 bad thing on line 2 [E1]');
    expect(on.result('w1')!.output.isError).toBe(false);
    const off = run(settings, script, ['-p', 'write it', '--sandbox', 'off', '--lsp', 'off']);
    expect(off.result('w1')!.output.text).toBe('created a.txt (2 lines)');
    // A server the policy would not let bash run is not started.
    const denied = run(settings, script, ['-p', 'write it', '--sandbox', 'off', '--deny', 'bash(*fake-lsp*)']);
    expect(denied.result('w1')!.output.text).toBe('created a.txt (2 lines)');
    expect(denied.err).toContain('the fake language server was not started: the permission policy does not let bash run');
  });

  test.skipIf(!process.env.CEDIA_REQUIRE_SANDBOX && !Bun.which('bwrap') && process.platform !== 'darwin')('the server runs in the sandbox, as bash does', () => {
    const outside = mkdtempSync(join(process.env.HOME ?? tmpdir(), '.cedia-lsp-probe-'));
    const probe = join(outside, 'escaped');
    const settings = { lsp: { fake: { command: [process.execPath, FAKE, '--probe', probe], extensions: ['.txt'] } } };
    try {
      const r = run(settings, [write('w1', 'a.txt', 'ERR\n'), reply('done')], ['-p', 'write it', '--sandbox', 'on']);
      expect(r.result('w1')!.output.text).toContain('fake reports 1 error in a.txt');
      expect(existsSync(probe)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
