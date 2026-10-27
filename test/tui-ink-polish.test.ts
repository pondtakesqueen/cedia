import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeContext, findCommand, IDLE_OVERLAY, resolveBindings, vimInputGate } from '../src/clients/tui-ink/keybindings/resolver.ts';
import { keybindingsPath, watchKeybindings } from '../src/clients/tui-ink/keybindings/loader.ts';
import { cancelStep, offsetForIndex } from '../src/clients/tui-ink/row-map.ts';

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

  test('the keybindings watcher stops when its disposer runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-keys-'));
    const seen: number[] = [];
    const stop = watchKeybindings(home, (b) => { seen.push(b.length); });
    stops.push(stop);
    writeFileSync(keybindingsPath(home), JSON.stringify({ bindings: [{ key: 'ctrl+x', command: 'quit', context: 'Chat' }] }));
    const start = Date.now();
    while (seen.length === 0 && Date.now() - start < 3000) await Bun.sleep(100);
    expect(seen.length).toBeGreaterThan(0);
    stop();
    stops.pop();
    await Bun.sleep(200);
    const n = seen.length;
    writeFileSync(keybindingsPath(home), JSON.stringify({ bindings: [] }));
    await Bun.sleep(1200);
    expect(seen.length).toBe(n);
  });
});
