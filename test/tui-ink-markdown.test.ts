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
