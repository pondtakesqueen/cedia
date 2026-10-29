import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { INK_THEMES, resolveThemeName, inkTheme, setTerminalTheme, themeFromColorfgbg, themeFromOsc11, tokensFor, truecolor } from '../src/clients/tui-ink/theme-tokens.ts';
import { DA1_QUERY, OSC11_QUERY, queryTerminalTheme } from '../src/clients/tui-ink/terminal-theme.ts';

// A terminal that answers what it is sent with `reply` (or nothing).
function fakeTerminal(reply: ((sent: string) => string | undefined) | undefined) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: (on: boolean) => void };
  const modes: boolean[] = [];
  Object.assign(stdin, { isTTY: true, isRaw: false, setRawMode: (on: boolean) => { modes.push(on); } });
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true });
  (stdout as unknown as PassThrough).on('data', (d: Buffer) => {
    const r = reply?.(d.toString());
    if (r) setTimeout(() => (stdin as unknown as PassThrough).write(r), 5);
  });
  return { stdin, stdout, modes };
}

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
    const t = inkTheme('/nonexistent-home-xyz', {});
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

  test('a background color picks light or dark, from OSC 11 or COLORFGBG', () => {
    expect(themeFromOsc11('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toBe('light');
    expect(themeFromOsc11('\x1b]11;rgb:f7f7/f7f7/f7f7\x07')).toBe('light');
    expect(themeFromOsc11('\x1b]11;rgb:1414/1717/1c1c\x1b\\')).toBe('dark');
    // Two hex digits a channel, as some terminals send.
    expect(themeFromOsc11('\x1b]11;rgb:fa/fa/fa\x07')).toBe('light');
    expect(themeFromOsc11('\x1b[?62;22c')).toBeUndefined();
    expect(themeFromColorfgbg({ COLORFGBG: '0;15' })).toBe('light');
    expect(themeFromColorfgbg({ COLORFGBG: '15;default;0' })).toBe('dark');
    expect(themeFromColorfgbg({})).toBeUndefined();
  });

  test('the theme in settings wins over the terminal, which wins over COLORFGBG', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-theme-'));
    try {
      expect(inkTheme(home, { COLORFGBG: '0;15' }).name).toBe('light');
      setTerminalTheme('dark');
      expect(inkTheme(home, { COLORFGBG: '0;15' }).name).toBe('dark');
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ theme: 'light' }));
      expect(inkTheme(home, {}).name).toBe('light');
    } finally {
      setTerminalTheme(undefined);
    }
  });

  test('the TUI asks the terminal for its background, and gives up when it only answers DA1 or not at all', async () => {
    const light = fakeTerminal((sent) => (sent.includes(OSC11_QUERY) ? '\x1b]11;rgb:f7f7/f7f7/f7f7\x1b\\\x1b[?62;22c' : undefined));
    expect(await queryTerminalTheme(light.stdin, light.stdout)).toBe('light');
    // Raw for the question, then back as it was.
    expect(light.modes).toEqual([true, false]);
    const silent = fakeTerminal((sent) => (sent.includes(DA1_QUERY) ? '\x1b[?1;2c' : undefined));
    const t0 = Date.now();
    expect(await queryTerminalTheme(silent.stdin, silent.stdout, 2000)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
    const none = fakeTerminal(undefined);
    expect(await queryTerminalTheme(none.stdin, none.stdout, 50)).toBeUndefined();
    // Not a terminal: no question at all.
    const pipe = fakeTerminal(undefined);
    Object.assign(pipe.stdin, { isTTY: false });
    expect(await queryTerminalTheme(pipe.stdin, pipe.stdout)).toBeUndefined();
    expect(pipe.modes).toEqual([]);
  });
});
