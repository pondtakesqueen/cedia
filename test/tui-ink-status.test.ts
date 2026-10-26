import { describe, expect, test } from 'bun:test';

describe('ink status bar', () => {
  test('module imports', async () => {
    const mod = await import('../src/clients/tui-ink/status-bar.tsx');
    expect(mod).toBeTruthy();
    expect(typeof mod.StatusBar).toBe('function');
  });
});
