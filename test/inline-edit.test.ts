import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inlineEditPrompt, parseRange, rangeOffsets, replacementText, selectionPatch } from '../src/core/project/inline-edit.ts';
import { SessionLog } from '../src/core/session/log.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const FILE = ['function add(a, b) {', '  return a - b;', '}', ''].join('\n');

function cedia(reply: string, args: string[], stdin?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-inline-'));
  writeFileSync(join(dir, 'script.json'), JSON.stringify([{ blocks: [{ type: 'text', text: reply }] }]));
  writeFileSync(join(dir, 'math.js'), FILE);
  const home = join(dir, 'home');
  const p = Bun.spawnSync([BIN, 'inline-edit', '--cwd', dir, '--model', 'faux', ...args], {
    env: { ...process.env, CEDIA_FAUX_SCRIPT: join(dir, 'script.json'), CEDIA_HOME: home },
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), home, dir };
}

describe('inline edit', () => {
  test('ranges parse and are checked against the text', () => {
    expect(parseRange('2:3-2:15')).toEqual({ start: { line: 2, column: 3 }, end: { line: 2, column: 15 } });
    expect(parseRange('2:3')).toBeUndefined();
    expect(rangeOffsets(FILE, parseRange('2:10-2:15')!)).toEqual({ from: 30, to: 35 });
    expect(FILE.slice(30, 35)).toBe('a - b');
    expect(rangeOffsets(FILE, parseRange('9:1-9:1')!)).toEqual({ error: expect.stringContaining('the file has 4') });
    expect(rangeOffsets(FILE, parseRange('2:40-2:41')!)).toEqual({ error: expect.stringContaining('line 2 has 15 characters') });
    expect(rangeOffsets(FILE, parseRange('2:5-1:1')!)).toEqual({ error: 'the range ends before it starts' });
    expect(rangeOffsets(FILE, parseRange('0:1-1:1')!)).toEqual({ error: expect.stringContaining('count from 1') });
  });

  test('the reply\'s replacement block is the new text', () => {
    expect(replacementText('<replacement>a + b</replacement>')).toBe('a + b');
    expect(replacementText('Sure.\n<replacement>\n  x();\n</replacement>')).toBe('  x();');
    expect(replacementText('<replacement></replacement>')).toBe('');
    expect(replacementText('```js\na + b\n```')).toBe('a + b');
  });

  test('the patch is one hunk with context, and none when nothing changes', () => {
    expect(selectionPatch('math.js', FILE, 30, 35, 'a + b')).toBe(['--- a/math.js', '+++ b/math.js', '@@ -1,4 +1,4 @@', ' function add(a, b) {', '-  return a - b;', '+  return a + b;', ' }', ' ', ''].join('\n'));
    expect(selectionPatch('math.js', FILE, 30, 35, 'a - b')).toBe('');
    // An insertion where nothing was selected adds lines.
    expect(selectionPatch('math.js', FILE, 21, 21, '  // sum\n')).toContain('@@ -1,4 +1,5 @@\n function add(a, b) {\n+  // sum\n   return a - b;');
  });

  test('the file goes in the frame with the selection marked; the instruction stays the person\'s words', () => {
    const p = inlineEditPrompt('math.js', FILE, 30, 35, 'fix the sum');
    expect(p.startsWith('fix the sum\n')).toBe(true);
    expect(p).toContain('<<<SELECTIONa - bSELECTION>>>');
    expect(p).toContain('<file>');
  });

  test('cedia inline-edit --json answers the replacement and patch, logs the session, and writes nothing', () => {
    const r = cedia('<replacement>a + b</replacement>', ['--file', 'math.js', '--range', '2:10-2:15', '--instruction', 'fix the sum', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ file: 'math.js', replacement: 'a + b', model: 'faux/scripted', range: { start: { line: 2, column: 10 } } });
    expect(out.patch).toContain('+  return a + b;');
    expect(Bun.file(join(r.dir, 'math.js')).size).toBe(FILE.length);
    const root = join(r.home, 'sessions');
    const [project] = readdirSync(root);
    const [file] = readdirSync(join(root, project!));
    const events = SessionLog.load(join(root, project!, file!)).events;
    expect(events[0]).toMatchObject({ kind: 'session', role: 'edit', tools: [] });
    expect(events.find((e) => e.kind === 'user')).toMatchObject({ text: expect.stringContaining('<<<SELECTIONa - bSELECTION>>>') });
  });

  test('--stdin edits the editor\'s text, unsaved changes included', () => {
    const r = cedia('<replacement>a * b</replacement>', ['--file', 'math.js', '--range', '2:10-2:15', '--instruction', 'multiply', '--stdin', '--json'], FILE.replace('a - b', 'a / b'));
    expect(JSON.parse(r.out).patch).toContain('-  return a / b;\n+  return a * b;');
  });

  test('refusals: outside the project, an empty instruction, a bad range, a secret in the selection', () => {
    expect(JSON.parse(cedia('x', ['--file', '../x.js', '--range', '1:1-1:1', '--instruction', 'x', '--json']).out).error).toContain('outside');
    expect(JSON.parse(cedia('x', ['--file', 'math.js', '--range', '1:1-1:1', '--instruction', ' ', '--json']).out).error).toBe('the instruction is empty');
    expect(JSON.parse(cedia('x', ['--file', 'math.js', '--range', '7:1-7:1', '--instruction', 'x', '--json']).out).error).toContain('the file has 4');
    const secret = `const key = "sk-ant-${'a'.repeat(30)}";\n`;
    const r = cedia('<replacement>x</replacement>', ['--file', 'math.js', '--range', '1:1-1:30', '--instruction', 'x', '--stdin', '--json'], secret);
    expect(JSON.parse(r.out).error).toContain('holds a secret');
    expect(cedia('x', ['--file', 'math.js']).code).toBe(2);
  });

  test('a secret outside the selection is redacted before the model sees it, and a reply that writes it back is refused', () => {
    const text = `const key = "sk-ant-${'a'.repeat(30)}";\nlet n = 1;\n`;
    const ok = cedia('<replacement>let n = 2;</replacement>', ['--file', 'math.js', '--range', '2:1-2:11', '--instruction', 'two', '--stdin', '--json'], text);
    expect(JSON.parse(ok.out).replacement).toBe('let n = 2;');
    const root = join(ok.home, 'sessions');
    const [project] = readdirSync(root);
    const [file] = readdirSync(join(root, project!));
    const user = SessionLog.load(join(root, project!, file!)).events.find((e) => e.kind === 'user') as { text: string };
    expect(user.text).not.toContain('sk-ant-');
    expect(user.text).toContain('[cedia:redacted]');
    const back = cedia('<replacement>[cedia:redacted]</replacement>', ['--file', 'math.js', '--range', '2:1-2:11', '--instruction', 'two', '--stdin', '--json'], text);
    expect(JSON.parse(back.out).error).toContain('redacted secret');
  });
});
