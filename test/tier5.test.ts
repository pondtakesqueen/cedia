import { describe, expect, test } from 'bun:test';
import { resolveBindings, findCommand } from '../src/clients/tui-ink/keybindings/resolver.ts';
import { ChordInterceptor } from '../src/clients/tui-ink/keybindings/chord.ts';
import { handleNormalKey, toInsert, toNormal } from '../src/clients/tui/vim/transitions.ts';
import { buildStatusLineInput, runStatusLineCommand } from '../src/clients/tui/statusline.ts';

const BIN = (import.meta as any).dir ? '' : '';
import { join } from 'node:path';
const BINP = join(import.meta.dir, '..', 'bin', 'cedia');

describe('tier5 keybindings', () => {
  test('overrides replace defaults', () => {
    const b = resolveBindings([{ key: 'enter', command: 'customSubmit', context: 'Chat' }]);
    expect(findCommand(b, 'enter', 'Chat')).toBe('customSubmit');
  });
  test('chord interceptor pending then handled', () => {
    const c = new ChordInterceptor((keys) => keys.join(',') === 'g,g');
    expect(c.push('g')).toBe('pending');
    expect(c.push('g')).toBe('handled');
  });
});

describe('tier5 vim', () => {
  test('transitions', () => {
    let s = toNormal({ mode: 'insert', insertedText: 'x' } as any);
    expect(s.mode).toBe('normal');
    const r = handleNormalKey(s, 'i');
    expect(r.state.mode).toBe('insert');
    expect(r.action).toBe('insert');
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