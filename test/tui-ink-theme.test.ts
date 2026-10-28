import { describe, expect, test } from 'bun:test';
import { INK_THEMES, resolveThemeName, inkTheme, tokensFor, truecolor } from '../src/clients/tui-ink/theme-tokens.ts';

describe('ink theme tokens', () => {
  test('both themes define the full token set', () => {
    const dark = Object.keys(INK_THEMES.dark).sort();
    const light = Object.keys(INK_THEMES.light).sort();
    expect(dark).toEqual(light);
    expect(dark.length).toBeGreaterThan(15);
  });

  test('hex colors are valid', () => {
    for (const t of [INK_THEMES.dark, INK_THEMES.light]) {
      for (const [k, v] of Object.entries(t)) {
        expect(v, k).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  test('resolveThemeName falls back to dark', () => {
    expect(resolveThemeName('light')).toBe('light');
    expect(resolveThemeName('dark')).toBe('dark');
    expect(resolveThemeName(undefined)).toBe('dark');
    expect(resolveThemeName('nope')).toBe('dark');
  });

  test('inkTheme reads settings.json or falls back', () => {
    const t = inkTheme('/nonexistent-home-xyz');
    expect(t.name).toBe('dark');
  });

  test('without truecolor the bands take exact 256-color entries, so add and remove stay apart', () => {
    expect(truecolor({ COLORTERM: 'truecolor' })).toBe(true);
    expect(truecolor({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
    const t = tokensFor('dark', { TERM: 'xterm-256color' });
    expect(t.diffAddedBg).not.toBe(t.diffRemovedBg);
    expect(t.diffAddedBg).toBe('#003300');
    expect(tokensFor('dark', { COLORTERM: 'truecolor' })).toEqual(INK_THEMES.dark);
  });
});
