import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISMISS_NOTE, noticeLines, PermissionDialog } from '../src/clients/tui-ink/permission-dialogs.tsx';
import { activeContext, findCommand, IDLE_OVERLAY, resolveBindings, vimInputGate } from '../src/clients/tui-ink/keybindings/resolver.ts';
import { keybindingsPath, watchKeybindings } from '../src/clients/tui-ink/keybindings/loader.ts';
import { cancelStep, offsetForIndex, rowMapFromWalk, selectionBounds } from '../src/clients/tui-ink/row-map.ts';
import { highlightQuery, offsetAt } from '../src/clients/tui-ink/autocomplete.ts';

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('ink key context', () => {
  test('transcript search is not Chat, so enter is not submit', () => {
    const search = { ...IDLE_OVERLAY, transcriptSearch: true };
    expect(activeContext(search)).toBe('Transcript');
    expect(activeContext(IDLE_OVERLAY)).toBe('Chat');
    expect(findCommand(resolveBindings([]), 'enter', activeContext(search))).toBeUndefined();
    expect(findCommand(resolveBindings([]), 'enter', 'Chat')).toBe('submit');
    expect(vimInputGate('Transcript', false)).toEqual({ captured: true, suppressSubmit: false });
    expect(vimInputGate('Autocomplete', false)).toEqual({ captured: false, suppressSubmit: true });
    expect(vimInputGate('Chat', false)).toEqual({ captured: false, suppressSubmit: false });
    expect(vimInputGate('Chat', true)).toEqual({ captured: true, suppressSubmit: false });
  });

  test('the first true overlay wins', () => {
    expect(activeContext({ ...IDLE_OVERLAY, settings: true, autocomplete: true })).toBe('Settings');
    expect(activeContext({ ...IDLE_OVERLAY, permissionNotice: true, transcriptSearch: true })).toBe('Confirmation');
  });

  test('cancel stops a turn before it closes an overlay', () => {
    expect(cancelStep({ running: true, overlay: true, editorEmpty: false })).toBe('abort-turn');
    expect(cancelStep({ running: false, overlay: true, editorEmpty: false })).toBe('close-overlay');
    expect(cancelStep({ running: false, overlay: false, editorEmpty: false })).toBe('clear-input');
    expect(cancelStep({ running: false, overlay: false, editorEmpty: true })).toBe('exit');
  });

  test('jump offset pins the match as the last included message', () => {
    expect(offsetForIndex(10, 0)).toBe(9);
    expect(offsetForIndex(10, 9)).toBe(0);
    expect(offsetForIndex(0, 3)).toBe(0);
    expect(offsetForIndex(10, -4)).toBe(9);
    expect(offsetForIndex(10, 40)).toBe(0);
  });

  test('a painted row map addresses display messages, not chrome', () => {
    const map = rowMapFromWalk([
      { kind: 'chrome', rows: 2 },
      { kind: 'message', index: 4, rows: 3 },
    ]);
    expect(map.rowAt(2)).toEqual({ index: 4, rowInSpan: 0 });
    expect(map.rowAt(4)).toEqual({ index: 4, rowInSpan: 2 });
    expect(map.rowAt(1)).toBeUndefined();
    expect(map.rowAt(5)).toBeUndefined();
  });

  test('selection bounds use display indexes and the dragged endpoints', () => {
    expect(selectionBounds({ aMsg: 1, aCol: 2, bMsg: 3, bCol: 4 }, 0, 10)).toBeUndefined();
    expect(selectionBounds({ aMsg: 1, aCol: 2, bMsg: 3, bCol: 4 }, 1, 10)).toEqual({ start: 2, end: 10 });
    expect(selectionBounds({ aMsg: 1, aCol: 2, bMsg: 3, bCol: 4 }, 2, 10)).toEqual({ start: 0, end: 10 });
    expect(selectionBounds({ aMsg: 1, aCol: 2, bMsg: 3, bCol: 4 }, 3, 10)).toEqual({ start: 0, end: 5 });
    expect(selectionBounds({ aMsg: 3, aCol: 1, bMsg: 1, bCol: 4 }, 1, 10)).toEqual({ start: 4, end: 10 });
    expect(selectionBounds({ aMsg: 2, aCol: 4, bMsg: 2, bCol: 1 }, 2, 10)).toEqual({ start: 1, end: 5 });
  });

  test('highlightQuery is a case-insensitive literal', () => {
    expect(highlightQuery('Hello hello', 'HELLO')).toEqual([
      { text: 'Hello', hit: true },
      { text: ' ', hit: false },
      { text: 'hello', hit: true },
    ]);
    expect(highlightQuery('a.b', '.')).toEqual([
      { text: 'a', hit: false },
      { text: '.', hit: true },
      { text: 'b', hit: false },
    ]);
    expect(highlightQuery('aaaa', 'aa')).toEqual([{ text: 'aaaa', hit: true }]);
    expect(highlightQuery('nope', '')).toEqual([{ text: 'nope', hit: false }]);
    expect(highlightQuery('nope', 'zz')).toEqual([{ text: 'nope', hit: false }]);
  });

  test('offsetAt uses the same character wrap as the row estimate', () => {
    expect(offsetAt('Hello', 10, 0, 2)).toBe(2);
    expect(offsetAt('Hello', 10, 0, 99)).toBe(5);
    expect(offsetAt('Hello', 10, 4, 0)).toBe(5);
    expect(offsetAt('abcdefghijXY', 10, 1, 0)).toBe(10);
    expect(offsetAt('abcdefghijXY', 10, 1, 5)).toBe(12);
    expect(offsetAt('ab\ncd', 10, 1, 1)).toBe(4);
    expect(offsetAt('abcdefghijkl', 3, 1, 0)).toBe(10);
  });

  test('a denial notice names the tool fields and offers no allow or deny caption', async () => {
    expect(noticeLines('bash', { command: 'rm -rf x' }).map((line) => line.label)).toEqual(['command']);
    expect(noticeLines('bash', { command: 'ls', timeout_ms: 1000 }).map((line) => line.label)).toEqual(['command', 'timeout_ms']);
    expect(noticeLines('edit', {
      path: 'a.ts',
      edits: [{ old_text: 'a', new_text: 'b' }, { old_text: 'c', new_text: 'd' }],
    }).map((line) => line.label)).toEqual(['path', 'old_text', 'new_text', 'edits']);
    expect(noticeLines('write', { path: 'a.ts', content: 'hello' })).toContainEqual({ label: 'content', value: '5 chars, hello' });
    expect(noticeLines('WebFetch', { url: 'https://example.test' }).map((line) => line.label)).toEqual(['url']);
    expect(noticeLines('web_fetch', { url: 'https://example.test', offset: 12 }).map((line) => line.label)).toEqual(['url', 'offset']);
    expect(noticeLines('skill', { skill: 'poteto', file: 'SKILL.md' })).toEqual([
      { label: 'name', value: 'poteto' },
      { label: 'file', value: 'SKILL.md' },
    ]);
    expect(noticeLines('grep', { pattern: 'x' })[0]?.label).toBe('input');
    expect(noticeLines('bash', { command: 'x'.repeat(250) })[0]?.value).toHaveLength(200);
    expect(DISMISS_NOTE.includes('Allow')).toBe(false);
    expect(DISMISS_NOTE.includes('Deny')).toBe(false);

    let out = '';
    const stdin = new PassThrough();
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
    const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
    stdout.columns = 80;
    stdout.rows = 24;
    stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const { unmount } = render(React.createElement(PermissionDialog, {
      tool: 'bash',
      input: { command: 'rm -rf x' },
      reason: 'blocked',
      rule: 'read-only',
    }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    });
    await Bun.sleep(200);
    unmount();
    const text = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    expect(text).toContain('bash denied');
    expect(text).toContain('command: rm -rf x');
    expect(text).toContain(DISMISS_NOTE);
    expect(text).not.toContain('[Allow]');
    expect(text).not.toContain('[Deny]');
  });

  test('the keybindings watcher stops when its disposer runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-keys-'));
    const path = keybindingsPath(home);
    writeFileSync(path, JSON.stringify({ bindings: [] }));
    const seen: number[] = [];
    const stop = watchKeybindings(home, (b) => { seen.push(b.length); });
    stops.push(stop);
    await Bun.sleep(700);
    writeFileSync(path, JSON.stringify({ bindings: [{ key: 'ctrl+x', command: 'quit', context: 'Chat' }] }));
    const start = Date.now();
    while (seen.length === 0 && Date.now() - start < 4000) await Bun.sleep(100);
    expect(seen.some((n) => n === 1)).toBe(true);
    stop();
    stops.pop();
    await Bun.sleep(600);
    const n = seen.length;
    writeFileSync(path, JSON.stringify({ bindings: [] }));
    await Bun.sleep(1500);
    expect(seen.length).toBe(n);
  });
});
