import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completePrompt, completionText } from '../src/core/project/complete.ts';
import { SessionLog } from '../src/core/session/log.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const FILE = ['function add(a, b) {', '  return ', '}', ''].join('\n');

function cedia(reply: string, args: string[], stdin?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-complete-'));
  writeFileSync(join(dir, 'script.json'), JSON.stringify([{ blocks: [{ type: 'text', text: reply }] }]));
  writeFileSync(join(dir, 'math.js'), FILE);
  const home = join(dir, 'home');
  const p = Bun.spawnSync([BIN, 'complete', '--cwd', dir, '--model', 'faux', ...args], {
    env: { ...process.env, CEDIA_FAUX_SCRIPT: join(dir, 'script.json'), CEDIA_HOME: home },
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), home, dir };
}

const events = (home: string) => {
  const root = join(home, 'sessions');
  const [project] = readdirSync(root);
  const [file] = readdirSync(join(root, project!));
  return SessionLog.load(join(root, project!, file!)).events;
};

describe('tab completion', () => {
  test('the prompt marks the cursor in the framed file', () => {
    const p = completePrompt('math.js', FILE, 30);
    expect(p).toContain('<<<CURSOR>>>');
    expect(p).toContain('  return <<<CURSOR>>>\n}');
    expect(p).not.toContain('shown around the cursor only');
    expect(completePrompt('big.js', 'x'.repeat(20_000), 10_000)).toContain('shown around the cursor only');
  });

  test("the reply's block is the text, less what already follows the cursor on its line", () => {
    expect(completionText('<completion>a + b;</completion>', '\n}')).toBe('a + b;');
    expect(completionText('Sure: <completion></completion>', '')).toBe('');
    expect(completionText('```js\na + b;\n```', '')).toBe('a + b;');
    // The editor keeps `);` after the cursor, so a reply that writes it again would show it twice.
    expect(completionText('<completion>a, b);</completion>', ');\nnext()')).toBe('a, b');
    // The block's own line breaks go; a leading one stays where the code before the cursor ends a line.
    expect(completionText('<completion>\n  x();\n</completion>', '', '  ')).toBe('  x();');
    expect(completionText('<completion>\nis_empty()</completion>', '', 'if !notes.')).toBe('is_empty()');
    expect(completionText('<completion>\n  x();\n</completion>', '', 'if (a) {')).toBe('\n  x();');
    // The `}` the editor already closed the block with is not offered again.
    expect(completionText('<completion>length;\n}</completion>', '\n}\n', '  return xs.')).toBe('length;');
    expect(completionText('<completion>xs[i];\n  }\n}</completion>', '\n  }\n}\n', '  return ')).toBe('xs[i];');
    expect(completionText('<completion>}</completion>', '\n}', '  ')).toBe('}');
    // A closer the reply never opened ends a block that goes on below; one it opened stays.
    expect(completionText('<completion>xs[i];\n  }</completion>', '\n  return 0;\n}', '  const x = ')).toBe('xs[i];');
    expect(completionText('<completion>if (a) {\n  x();\n}</completion>', '\n  return 0;\n}', '  ')).toBe('if (a) {\n  x();\n}');
    // Mid-line after `:` or `(`, a reply that starts on a new line still goes on this one.
    expect(completionText('<completion>\nbefore + text</completion>', ', startColumn: 1 }', '{ insertText: ')).toBe('before + text');
    // Cut off by the token cap: the whole lines only.
    expect(completionText('<completion>a();\nb();\nc(1, ', '')).toBe('a();\nb();');
    expect(completionText('<completion>a(1, ', '')).toBe('');
    // With text after the cursor, a line break would strand it: the first line only, less the repeated `;`.
    expect(completionText('<completion>xs.length;\n}</completion>', ';\n}')).toBe('xs.length');
    expect(completionText('<completion>a, b)</completion>', ');')).toBe('a, b');
    // Only closing punctuation counts as repeated, never a word the cursor is before.
    expect(completionText('<completion>foo</completion>', 'o.bar()')).toBe('foo');
    expect(completionText('<completion>before + text };</completion>', ' };')).toBe('before + text');
  });

  test('cedia complete --json answers the text at the cursor in one short request, logs it, and writes nothing', () => {
    const r = cedia('<completion>a + b;</completion>', ['--file', 'math.js', '--at', '2:10', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ file: 'math.js', at: { line: 2, column: 10 }, text: 'a + b;', model: 'faux/scripted', ms: expect.any(Number) });
    expect(Bun.file(join(r.dir, 'math.js')).size).toBe(FILE.length);
    const log = events(r.home);
    expect(log[0]).toMatchObject({ kind: 'session', role: 'complete', tools: [] });
    expect(log.find((e) => e.kind === 'user')).toMatchObject({ text: expect.stringContaining('  return <<<CURSOR>>>') });
    expect(log.find((e) => e.kind === 'request')).toMatchObject({ maxTokens: 256 });
  });

  test('one turn is the answer, even when the loop would go on past the token cap or an empty reply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-complete-'));
    writeFileSync(join(dir, 'script.json'), JSON.stringify([{ blocks: [{ type: 'text', text: '<completion>a + b;\nnext(' }], stop: 'max_tokens' }]));
    writeFileSync(join(dir, 'math.js'), FILE);
    const p = Bun.spawnSync([BIN, 'complete', '--cwd', dir, '--model', 'faux', '--file', 'math.js', '--at', '2:10', '--json'], {
      env: { ...process.env, CEDIA_FAUX_SCRIPT: join(dir, 'script.json'), CEDIA_HOME: join(dir, 'home') },
    });
    expect(JSON.parse(p.stdout.toString())).toMatchObject({ text: 'a + b;' });
    expect(JSON.parse(cedia('', ['--file', 'math.js', '--at', '2:10', '--json']).out)).toMatchObject({ text: '' });
  });

  test('--stdin completes the editor\'s text, and refusals say why', () => {
    const r = cedia('<completion>a * b;</completion>', ['--file', 'math.js', '--at', '2:12', '--stdin', '--json'], FILE.replace('return ', 'return x+'));
    expect(JSON.parse(r.out).text).toBe('a * b;');
    expect(events(r.home).find((e) => e.kind === 'user')).toMatchObject({ text: expect.stringContaining('return x+<<<CURSOR>>>') });
    expect(JSON.parse(cedia('x', ['--file', '../x.js', '--at', '1:1', '--json']).out).error).toContain('outside');
    expect(JSON.parse(cedia('x', ['--file', 'math.js', '--at', '9:1', '--json']).out).error).toContain('the file has 4');
    expect(cedia('x', ['--file', 'math.js']).code).toBe(2);
  });

  test('a secret in the file is redacted before the model sees it, and a reply that writes the placeholder offers nothing', () => {
    const text = `const key = "sk-ant-${'a'.repeat(30)}";\nlet n = \n`;
    const r = cedia('<completion>[cedia:redacted];</completion>', ['--file', 'math.js', '--at', '2:9', '--stdin', '--json'], text);
    expect(JSON.parse(r.out).text).toBe('');
    expect(JSON.stringify(events(r.home))).not.toContain('sk-ant-');
  });
});
