import { describe, expect, test } from 'bun:test';
import { SPLASH_MIN_COLUMNS, SPLASH_MIN_ROWS, WORDMARK_WIDTH, showSplash, wordmark } from '../src/clients/tui-ink/splash.ts';

describe('the first screen (splash.ts)', () => {
  test('the wordmark is four rows of half blocks, all one width', () => {
    const rows = wordmark();
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.length).toBe(WORDMARK_WIDTH);
      expect(r).toMatch(/^[█▀▄ ]+$/);
    }
    // The d's ascender and the i's dot stand above the rest of the word.
    expect(rows[0]!.trim()).toBe('█ ▀▀');
    expect(WORDMARK_WIDTH).toBeLessThan(SPLASH_MIN_COLUMNS);
  });

  test('a screen reader, a short or a narrow terminal keep the plain header', () => {
    expect(showSplash(SPLASH_MIN_ROWS, SPLASH_MIN_COLUMNS, false)).toBe(true);
    expect(showSplash(SPLASH_MIN_ROWS - 1, 120, false)).toBe(false);
    expect(showSplash(40, SPLASH_MIN_COLUMNS - 1, false)).toBe(false);
    expect(showSplash(40, 120, true)).toBe(false);
  });
});
