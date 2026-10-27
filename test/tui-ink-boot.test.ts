// test/tui-ink-boot.test.ts
import { describe, expect, test } from 'bun:test';

describe('ink tui boot (smoke)', () => {
  test('app module imports without crashing', async () => {
    const mod = await import('../src/clients/tui-ink/app.tsx');
    expect(mod).toBeTruthy();
    expect(typeof mod.App).toBe('function');
  });

  test('index module imports without crashing', async () => {
    const mod = await import('../src/clients/tui-ink/index.ts');
    expect(mod).toBeTruthy();
    expect(typeof mod.runInkTui).toBe('function');
  });

  test('markdown + status modules import', async () => {
    const md = await import('../src/clients/tui-ink/markdown.tsx');
    const sb = await import('../src/clients/tui-ink/status-bar.tsx');
    expect(typeof md.default).toBe('function');
    expect(typeof sb.StatusBar).toBe('function');
  });
});