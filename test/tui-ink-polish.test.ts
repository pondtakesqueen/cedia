import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISMISS_NOTE, NOTICE_NOTE, noticeBlocks, noticeHunks, noticeLines, PermissionDialog } from '../src/clients/tui-ink/permission-dialogs.tsx';
import { completedNames, isComplete, reconcileOnboarding, saveOnboarding } from '../src/clients/tui-ink/onboarding.ts';
import { activeContext, findCommand, IDLE_OVERLAY, resolveBindings, vimInputGate } from '../src/clients/tui-ink/keybindings/resolver.ts';
import { keybindingsPath, watchKeybindings } from '../src/clients/tui-ink/keybindings/loader.ts';
import { cancelStep, messageFullySelected, offsetForIndex, rowMapFromWalk, selectionBounds } from '../src/clients/tui-ink/row-map.ts';
import { highlightQuery, offsetAt, paintRuns } from '../src/clients/tui-ink/autocomplete.ts';
import { createHeightCache, heightCacheKey, visibleWindow } from '../src/clients/tui-ink/visible-window.ts';
import { assignRecycleSlots, messageSlotKey } from '../src/clients/tui-ink/virtual-list.ts';
import { inkRenderOptions } from '../src/clients/tui-ink/render-options.ts';
import { attachSigcontRedraw, notifyTerminalResume, onTerminalResume } from '../src/clients/tui-ink/terminal-resume.ts';

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('ink key context', () => {
  test('transcript search is not Chat, so enter is not submit', () => {
    const search = { ...IDLE_OVERLAY, transcriptSearch: true };
    const bindings = resolveBindings([]);
    expect(activeContext(search)).toBe('Transcript');
    expect(activeContext(IDLE_OVERLAY)).toBe('Chat');
    expect(findCommand(bindings, 'enter', activeContext(search))).toBe('jump');
    expect(findCommand(bindings, 'enter', 'Chat')).toBe('submit');
    expect(findCommand(bindings, 'escape', 'Confirmation')).toBe('dismiss');
    expect(findCommand(bindings, 'tab', 'Settings')).toBe('nextTab');
    expect(findCommand(bindings, 'enter', 'Autocomplete')).toBe('accept');
    expect(vimInputGate('Transcript', false)).toEqual({ captured: true, suppressSubmit: false });
    expect(vimInputGate('Autocomplete', false)).toEqual({ captured: false, suppressSubmit: true });
    expect(vimInputGate('Chat', false)).toEqual({ captured: false, suppressSubmit: false });
    expect(vimInputGate('Chat', true)).toEqual({ captured: true, suppressSubmit: false });
  });

  test('a keybindings override rebinds an overlay key', () => {
    const bindings = resolveBindings([{ key: 'enter', command: 'close', context: 'Transcript' }]);
    expect(findCommand(bindings, 'enter', 'Transcript')).toBe('close');
    expect(findCommand(bindings, 'enter', 'Chat')).toBe('submit');
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

  test('messageFullySelected is true only for whole-message spans', () => {
    const multi = { aMsg: 1, aCol: 2, bMsg: 3, bCol: 4 };
    expect(messageFullySelected(multi, 1, 10)).toBe(false);
    expect(messageFullySelected(multi, 2, 10)).toBe(true);
    expect(messageFullySelected(multi, 3, 10)).toBe(false);
    expect(messageFullySelected({ aMsg: 2, aCol: 0, bMsg: 2, bCol: 9 }, 2, 10)).toBe(true);
    expect(messageFullySelected({ aMsg: 2, aCol: 1, bMsg: 2, bCol: 9 }, 2, 10)).toBe(false);
    expect(messageFullySelected(null, 0, 5)).toBe(false);
    expect(messageFullySelected(multi, 2, 0)).toBe(false);
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

  test('visibleWindow fills a height budget and applies overscan', () => {
    const heights = [2, 2, 2, 2, 2, 2, 2, 2];
    const win = visibleWindow({
      count: heights.length,
      scrollOffset: 0,
      budget: 6,
      overscan: 2,
      heightAt: (i) => heights[i]!,
    });
    expect(win.end).toBe(8);
    expect(win.start).toBe(3);
    expect(win.used).toBe(6);
    const scrolled = visibleWindow({
      count: heights.length,
      scrollOffset: 3,
      budget: 4,
      overscan: 1,
      heightAt: (i) => heights[i]!,
    });
    expect(scrolled.end).toBe(5);
    expect(scrolled.start).toBe(2);
    expect(visibleWindow({ count: 0, scrollOffset: 0, budget: 10, heightAt: () => 1 })).toEqual({
      start: 0, end: 0, used: 0,
    });
  });

  test('assignRecycleSlots reuses slots for the same message key', () => {
    const items = [
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
      { role: 'user', text: 'c' },
      { role: 'assistant', text: 'd' },
    ];
    const keyAt = (i: number) => messageSlotKey(items[i]!, i);
    const first = assignRecycleSlots(1, 3, keyAt);
    expect(first.map((s) => s.index)).toEqual([1, 2]);
    const slotFor = Object.fromEntries(first.map((s) => [s.key, s.slot]));
    const slid = assignRecycleSlots(2, 4, keyAt, first);
    expect(slid.map((s) => s.index)).toEqual([2, 3]);
    const kept = slid.find((s) => s.index === 2);
    expect(kept?.slot).toBe(slotFor[keyAt(2)]);
    expect(assignRecycleSlots(0, 0, keyAt)).toEqual([]);
  });

  test('height cache returns the same estimate until cleared', () => {
    const cache = createHeightCache();
    let calls = 0;
    const key = heightCacheKey(0, 80, 12, 'assistant');
    expect(cache.lines(key, () => { calls++; return 3; })).toBe(3);
    expect(cache.lines(key, () => { calls++; return 9; })).toBe(3);
    expect(calls).toBe(1);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.lines(key, () => { calls++; return 4; })).toBe(4);
    expect(calls).toBe(2);
  });

  test('paintRuns composes selection and search hits', () => {
    expect(paintRuns('abcdef', { query: 'cd', selection: { start: 1, end: 5 } })).toEqual([
      { text: 'a', hit: false, selected: false },
      { text: 'b', hit: false, selected: true },
      { text: 'cd', hit: true, selected: true },
      { text: 'e', hit: false, selected: true },
      { text: 'f', hit: false, selected: false },
    ]);
    expect(paintRuns('hello', { query: 'ell' })).toEqual([
      { text: 'h', hit: false, selected: false },
      { text: 'ell', hit: true, selected: false },
      { text: 'o', hit: false, selected: false },
    ]);
    expect(paintRuns('hi', { selection: { start: 0, end: 2 } })).toEqual([
      { text: 'hi', hit: false, selected: true },
    ]);
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
    expect(noticeBlocks('edit', {
      path: 'a.ts',
      edits: [{ old_text: 'old line', new_text: 'new line' }, { old_text: 'c', new_text: 'd' }],
    })).toEqual([
      { kind: 'field', label: 'path', value: 'a.ts' },
      { kind: 'removed', text: 'old line' },
      { kind: 'added', text: 'new line' },
      { kind: 'field', label: 'edits', value: '2' },
    ]);
    expect(noticeBlocks('write', { path: 'a.ts', content: 'hello\nworld\nthird' })).toEqual([
      { kind: 'field', label: 'path', value: 'a.ts' },
      { kind: 'field', label: 'lines', value: '3' },
      { kind: 'preview', text: 'hello' },
      { kind: 'preview', text: 'world' },
      { kind: 'preview', text: 'third' },
    ]);
    expect(noticeLines('WebFetch', { url: 'https://example.test' }).map((line) => line.label)).toEqual(['url']);
    expect(noticeLines('web_fetch', { url: 'https://example.test', offset: 12 }).map((line) => line.label)).toEqual(['url', 'offset']);
    expect(noticeLines('skill', { skill: 'poteto', args: '--dry', file: 'SKILL.md' })).toEqual([
      { label: 'name', value: 'poteto' },
      { label: 'args', value: '--dry' },
      { label: 'file', value: 'SKILL.md' },
    ]);
    expect(noticeBlocks('enterPlanMode', { plan: 'ship the polish\nthen rest', action: 'enter' })).toEqual([
      { kind: 'field', label: 'action', value: 'enter' },
      { kind: 'preview', text: 'ship the polish' },
      { kind: 'preview', text: 'then rest' },
    ]);
    expect(noticeLines('filesystem', { op: 'rename', path: 'a', destination: 'b' }).map((line) => line.label)).toEqual(['op', 'path', 'destination']);
    expect(noticeLines('sed', { expression: 's/a/b/', path: 'x.ts' }).map((line) => line.label)).toEqual(['expression', 'path']);
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
      tool: 'edit',
      input: { path: 'a.ts', old_text: 'foo', new_text: 'bar' },
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
    // A panel: what was blocked, by which rule, the diff it would have made and how to close it.
    expect(text).toContain('✗ Blocked  Edit  a.ts');
    expect(text).toContain('rule  read-only · blocked');
    expect(text).toContain('- foo');
    expect(text).toContain('+ bar');
    expect(text).toContain(NOTICE_NOTE);
    expect(text).toContain('esc close');
    expect(text).not.toContain('[Allow]');
    expect(text).not.toContain('[Deny]');
  });

  test('a blocked edit is numbered from where its old text is in the file, and a write is all added lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-notice-'));
    writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\nfour\n');
    const edit = noticeHunks('edit', { path: 'a.ts', edits: [{ old_text: 'two\nthree', new_text: 'two\n3' }] }, dir);
    expect(edit?.hunks).toEqual([[{ sign: ' ', old: 2, new: 2, text: 'two' }, { sign: '-', old: 3, text: 'three' }, { sign: '+', new: 3, text: '3' }]]);
    // Not in the file (or no file): no numbers.
    expect(noticeHunks('edit', { path: 'gone.ts', old_text: 'x', new_text: 'y' }, dir)?.hunks[0]?.[0]).toEqual({ sign: '-', old: undefined, text: 'x' });
    expect(noticeHunks('write', { path: 'n.py', content: 'a\nb' })).toEqual({ hunks: [[{ sign: '+', new: 1, text: 'a' }, { sign: '+', new: 2, text: 'b' }]], lang: 'py' });
    expect(noticeHunks('bash', { command: 'ls' })).toBeUndefined();
  });

  test('onboarding is complete only when every step is recorded', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-onboard-'));
    saveOnboarding({ completed: ['preflight', 'theme', 'apiKey', 'trust'] }, home);
    expect(isComplete(home)).toBe(false);
    const once = reconcileOnboarding({ completed: ['theme'] }, { preflight: true, theme: true, trust: true });
    const twice = reconcileOnboarding(once, { preflight: true, theme: true, trust: true });
    expect(twice.completed).toEqual(once.completed);
    expect(twice.completed).toEqual(['theme', 'preflight', 'trust']);
    expect(twice.hasTrustDialogAccepted).toBe(true);
    const kept = reconcileOnboarding(twice, { preflight: false, trust: false });
    expect(kept.completed).toEqual(twice.completed);
    expect(kept.hasTrustDialogAccepted).toBe(true);
    const done = reconcileOnboarding(
      { completed: ['preflight', 'theme', 'apiKey', 'terminal'], hasTrustDialogAccepted: true },
      {},
    );
    expect([...completedNames(done)].sort()).toEqual(['apiKey', 'preflight', 'terminal', 'theme', 'trust']);
    saveOnboarding(done, home);
    expect(isComplete(home)).toBe(true);
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

  test('inkRenderOptions enables Frame-diff and a 60 fps schedule', () => {
    const opts = inkRenderOptions();
    expect(opts.incrementalRendering).toBe(true);
    expect(opts.maxFps).toBe(60);
    expect(opts.alternateScreen).toBe(true);
    expect(opts.exitOnCtrlC).toBe(false);
    expect(inkRenderOptions({ maxFps: 30 }).maxFps).toBe(30);
  });

  test('terminal resume notifies listeners and SIGCONT clears then notifies', () => {
    const ticks: number[] = [];
    const stop = onTerminalResume(() => { ticks.push(1); });
    stops.push(stop);
    notifyTerminalResume();
    expect(ticks).toEqual([1]);
    const cleared: number[] = [];
    const detach = attachSigcontRedraw(() => { cleared.push(1); });
    stops.push(detach);
    process.emit('SIGCONT');
    expect(cleared).toEqual([1]);
    expect(ticks).toEqual([1, 1]);
  });
});

describe('fitPath', () => {
  test('keeps the last parts of a path that does not fit', async () => {
    const { fitPath } = await import('../src/clients/tui-ink/app.tsx');
    expect(fitPath('~/code/cedia', 20)).toBe('~/code/cedia');
    expect(fitPath('/tmp/a-very-long-directory-name/scratchpad/demo', 24)).toBe('…/scratchpad/demo');
    expect(fitPath('/x/' + 'y'.repeat(30), 12)).toBe('…' + 'y'.repeat(11));
  });
});
