import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadSearch } from '../src/protocol/index.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });
const call = (id: string, name: string, input: unknown) => ({ blocks: [{ type: 'tool_use', id, name, input }] });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-search-'));
  const home = join(dir, '.home');
  Bun.spawnSync(['mkdir', '-p', home]);
  const run = (args: string[], script: unknown[] = []) => {
    const p = join(home, `script-${Math.random()}.json`);
    writeFileSync(p, JSON.stringify(script));
    const r = Bun.spawnSync([BIN, ...args, '--cwd', dir], { env: { ...process.env, CEDIA_FAUX_SCRIPT: p, CEDIA_HOME: home }, stdin: 'ignore' });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const prompt = (text: string, script: unknown[]) => JSON.parse(run(['-m', 'faux', '-p', text, '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json'], script).out).thread as string;
  const search = (args: string[]) => JSON.parse(run(['threads', 'search', ...args, '--json']).out) as ThreadSearch;
  return { run, prompt, search };
}

describe('cedia threads search (offline, faux)', () => {
  test('finds threads by what their sessions said or did, every term must match, title hits rank first', () => {
    const w = setup();
    const parser = w.prompt('fix the date parser', [call('c1', 'bash', { command: 'echo TimezoneOffsetError at parse.ts:42' }), reply('fixed the timezone bug')]);
    const docs = w.prompt('update the readme', [call('c2', 'write', { path: 'README.md', content: 'mentions timezone once\n' }), reply('readme updated')]);
    const other = w.prompt('timezone audit', [reply('nothing to do')]);

    const tz = w.search(['timezone']);
    expect(tz.threads.map((t) => t.thread)).toEqual([other, parser, docs]);

    const both = w.search(['TimezoneOffsetError', 'parse.ts']);
    expect(both.threads.map((t) => t.thread)).toEqual([parser]);
    expect(both.threads[0]!.snippets.some((s) => s.where === 'result bash' && s.text.includes('TimezoneOffsetError'))).toBe(true);

    expect(w.search(['readme|nonexistent', 'updated']).threads.map((t) => t.thread)).toEqual([docs]);
    expect(w.search(['nowhere-to-be-found']).threads).toEqual([]);
    expect(w.run(['threads', 'search', 'nowhere-to-be-found']).out).toContain('no thread matches');
  });

  test('--edited-path keeps the threads that edited a matching file, as the model named it', () => {
    const w = setup();
    const a = w.prompt('touch src', [call('c1', 'write', { path: 'src/app.ts', content: 'x\n' }), reply('ok')]);
    w.prompt('touch docs', [call('c2', 'write', { path: 'docs/a.md', content: 'y\n' }), reply('ok')]);
    const r = w.search(['--edited-path', 'src/**']);
    expect(r.threads.map((t) => t.thread)).toEqual([a]);
    expect(r.threads[0]!.edited).toEqual(['src/app.ts']);
    expect(w.search(['ok', '--edited-path', 'docs/*.md']).threads).toHaveLength(1);
  });
});
