import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNKNOWN_FOCUS_MS, channelFor, focusFrom, notifyModeFrom, notifySequence, resolveNotifyMode, shouldNotify, turnNotice } from '../src/clients/tui-ink/notify.ts';
import { checkSettings } from '../src/core/config.ts';

describe('turn-end notifications (notify.ts)', () => {
  test('the newest focus report wins; other input says nothing', () => {
    expect(focusFrom('\x1b[O')).toBe('blurred');
    expect(focusFrom('\x1b[I')).toBe('focused');
    expect(focusFrom('\x1b[O\x1b[I')).toBe('focused');
    expect(focusFrom('\x1b[I\x1b[O')).toBe('blurred');
    expect(focusFrom('abc')).toBeUndefined();
    expect(focusFrom('\x1b[<64;5;5M')).toBeUndefined();
  });

  test('only a terminal in the background is told, or one that never said after a long turn', () => {
    expect(shouldNotify('auto', 'blurred', 1000)).toBe(true);
    expect(shouldNotify('auto', 'focused', 10 * 60_000)).toBe(false);
    expect(shouldNotify('auto', 'unknown', 1000)).toBe(false);
    expect(shouldNotify('auto', 'unknown', UNKNOWN_FOCUS_MS)).toBe(true);
    expect(shouldNotify('bell', 'blurred', 1000)).toBe(true);
    expect(shouldNotify('off', 'blurred', UNKNOWN_FOCUS_MS)).toBe(false);
  });

  test('each terminal gets the escape it reads, tmux and the rest the bell', () => {
    expect(channelFor('auto', { TERM_PROGRAM: 'iTerm.app' })).toBe('osc9');
    expect(channelFor('auto', { TERM_PROGRAM: 'ghostty' })).toBe('osc9');
    expect(channelFor('auto', { TERM_PROGRAM: 'WezTerm' })).toBe('osc9');
    expect(channelFor('auto', { TERM: 'xterm-kitty' })).toBe('osc99');
    expect(channelFor('auto', { TERM: 'foot' })).toBe('osc777');
    expect(channelFor('auto', { VTE_VERSION: '7600' })).toBe('osc777');
    expect(channelFor('auto', { TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/tmux-1/default,1,0' })).toBe('bell');
    expect(channelFor('auto', { TERM_PROGRAM: 'Apple_Terminal' })).toBe('bell');
    expect(channelFor('bell', { TERM_PROGRAM: 'iTerm.app' })).toBe('bell');
  });

  test('a sequence carries no control characters of its own', () => {
    expect(notifySequence('osc9', 'cedia', 'Done in 4s')).toBe('\x1b]9;cedia: Done in 4s\x07');
    expect(notifySequence('osc777', 'ce;dia', 'a;b')).toBe('\x1b]777;notify;ce,dia;a,b\x07');
    expect(notifySequence('osc99', 'cedia', 'hi')).toBe('\x1b]99;i=1:d=0;cedia\x1b\\\x1b]99;i=1:p=body;hi\x1b\\');
    expect(notifySequence('bell', 'cedia', 'hi')).toBe('\x07');
    const evil = notifySequence('osc9', 'cedia', 'x\x07\x1b]0;pwned\x07\nnext');
    expect(evil).toBe('\x1b]9;cedia: x ]0;pwned next\x07');
    expect(notifySequence('osc9', 'cedia', 'y'.repeat(500)).length).toBeLessThan(230);
  });

  test('what a turn says depends on how it ended; a stop by the owner says nothing', () => {
    expect(turnNotice('success', 41_600)).toBe('Done in 42s');
    expect(turnNotice('asked', 2000, 'Which branch?')).toBe('Asks: Which branch?');
    expect(turnNotice('asked', 2000)).toBe('Waiting for your answer');
    expect(turnNotice('error_max_turns', 9000)).toBe('Ended (error max turns) after 9s');
    expect(turnNotice('interrupted', 9000)).toBeUndefined();
  });

  test('the mode comes from settings.json, auto when unset or unreadable', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-notify-'));
    expect(notifyModeFrom(home)).toBe('auto');
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ notify: 'off' }));
    expect(notifyModeFrom(home)).toBe('off');
    writeFileSync(join(home, 'settings.json'), '{');
    expect(notifyModeFrom(home)).toBe('auto');
    expect(resolveNotifyMode('loud')).toBe('auto');
  });

  test('core knows the setting and refuses a value it does not', () => {
    expect(checkSettings({ notify: 'bell' }).notify).toBe('bell');
    expect(() => checkSettings({ notify: 'loud' })).toThrow(/"notify" must be/);
  });
});
