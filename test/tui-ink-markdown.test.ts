// test/tui-ink-markdown.test.ts
import { describe, expect, test } from 'bun:test';

describe('ink markdown renderer', () => {
  test('module imports and exports a default component', async () => {
    const mod = await import('../src/clients/tui-ink/markdown.tsx');
    expect(typeof mod.default).toBe('function');
  });

  test('renderMarkdown returns a non-empty string for markdown input', async () => {
    const { renderMarkdown } = await import('../src/clients/tui-ink/markdown.tsx');
    const out = await renderMarkdown('# Hello\n\n- item one\n- item two\n');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('Hello');
    expect(out).toContain('item one');
  });

  test('renderMarkdown does not throw on empty input', async () => {
    const { renderMarkdown } = await import('../src/clients/tui-ink/markdown.tsx');
    const out = await renderMarkdown('');
    expect(typeof out).toBe('string');
  });

  test('renderMarkdown does not throw on code blocks', async () => {
    const { renderMarkdown } = await import('../src/clients/tui-ink/markdown.tsx');
    const out = await renderMarkdown('```ts\nconst x = 1;\n```\n');
    expect(out).toContain('const x = 1;');
  });
});

describe('ink markdown lines', () => {
  test('headings lose their #, bullets become •, inline marks are styled and dropped', async () => {
    const { mdLines, mdPlain } = await import('../src/clients/tui-ink/markdown.tsx');
    expect(mdPlain('## Fixed\n\n`add` was **wrong**.\n\n- one\n  - two\n1. first')).toBe('Fixed\n\nadd was wrong.\n\n  • one\n    • two\n  1. first');
    const [heading, , para] = mdLines('# Title\n\nsee `x` and [docs](https://d.example)');
    expect(heading).toEqual([{ text: 'Title', style: 'heading' }]);
    expect(para).toEqual([
      { text: 'see ', style: 'text' },
      { text: 'x', style: 'code' },
      { text: ' and ', style: 'text' },
      { text: 'docs', style: 'link' },
      { text: ' (https://d.example)', style: 'faint' },
    ]);
  });

  test('a code block gets a rule and its language, and an unclosed fence runs to the end', async () => {
    const { mdLines, mdPlain } = await import('../src/clients/tui-ink/markdown.tsx');
    expect(mdPlain('```js\nreturn 1; // one\n```')).toBe('┃ js\n┃ return 1; // one');
    const code = mdLines('```js\nreturn 1; // one')[1]!;
    expect(code.map((s) => s.style)).toEqual(['faint', 'kw', 'text', 'num', 'text', 'com']);
    expect(mdLines('```py\nx = "a" # c\n```')[1]!.at(-1)).toEqual({ text: '# c', style: 'com' });
  });

  test('a table lines up its columns', async () => {
    const { mdPlain } = await import('../src/clients/tui-ink/markdown.tsx');
    expect(mdPlain('| a | bbb |\n|---|---|\n| 1 | 2 |')).toBe('a │ bbb\n──┼────\n1 │ 2');
  });

  test('snake_case and a lone * stay as typed', async () => {
    const { mdPlain } = await import('../src/clients/tui-ink/markdown.tsx');
    expect(mdPlain('use snake_case_name and 2 * 3')).toBe('use snake_case_name and 2 * 3');
  });
});
