import { describe, expect, test } from 'bun:test';
import { resolveBindings, findCommand } from '../src/clients/tui-ink/keybindings/resolver.ts';
import { ChordInterceptor, chordsFromBindings, matchChord, parseChordKey } from '../src/clients/tui-ink/keybindings/chord.ts';
import { buildStatusLineInput, runStatusLineCommand } from '../src/clients/tui-ink/statusline.ts';

const BIN = (import.meta as any).dir ? '' : '';
import { join } from 'node:path';
const BINP = join(import.meta.dir, '..', 'bin', 'cedia');

describe('tier5 keybindings', () => {
  test('overrides replace defaults', () => {
    const b = resolveBindings([{ key: 'enter', command: 'customSubmit', context: 'Chat' }]);
    expect(findCommand(b, 'enter', 'Chat')).toBe('customSubmit');
  });
  test('chord interceptor pending then handled', () => {
    let fired = '';
    const chords = [{ keys: ['g', 'g'], command: 'scrollTop' }];
    const c = new ChordInterceptor((keys) => matchChord(keys, chords), (cmd) => { fired = cmd; });
    expect(c.push('g')).toBe('pending');
    expect(c.push('g')).toBe('handled');
    expect(fired).toBe('scrollTop');
  });
  test('unmatched keys fall through as none', () => {
    const chords = [{ keys: ['g', 'g'], command: 'scrollTop' }];
    const c = new ChordInterceptor((keys) => matchChord(keys, chords));
    expect(c.push('x')).toBe('none');
    expect(c.push('g')).toBe('pending');
    expect(c.push('x')).toBe('none');
  });
  test('parseChordKey and chordsFromBindings read multi-key bindings', () => {
    expect(parseChordKey('g g')).toEqual(['g', 'g']);
    expect(parseChordKey('g,g')).toEqual(['g', 'g']);
    expect(parseChordKey('enter')).toEqual(['enter']);
    const chords = chordsFromBindings(resolveBindings([]), 'Chat');
    expect(chords.some((c) => c.command === 'scrollTop' && c.keys.join(' ') === 'g g')).toBe(true);
    expect(findCommand(resolveBindings([]), 'g g', 'Chat')).toBe('scrollTop');
  });
});

describe('tier5 statusline', () => {
  test('builds json', () => {
    const s = buildStatusLineInput({ model: 'm', workspace: '/w', costUsd: 1, contextWindow: 100 });
    expect(JSON.parse(s).model).toBe('m');
  });
  test('runs command', () => {
    const out = runStatusLineCommand('echo hi', { model: 'm', workspace: '/w', costUsd: 1, contextWindow: 100 });
    expect(out).toBe('hi');
  });
});

describe('tier5 doctor', () => {
  test('outputs diagnostics', () => {
    const p = Bun.spawnSync([BINP, 'doctor', '--json']);
    expect(p.exitCode).toBe(0);
    const data = JSON.parse(p.stdout.toString());
    expect(typeof data.version).toBe('string');
    expect(typeof data.sandbox).toBe('object');
  });
});