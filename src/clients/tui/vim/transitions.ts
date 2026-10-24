import type { VimState } from './types.ts';

export function toInsert(state: VimState, text = ''): VimState {
  return { mode: 'insert', insertedText: text };
}

export function toNormal(state: VimState): VimState {
  return { mode: 'normal' };
}

export function toggleVim(current: 'vim' | 'default'): 'vim' | 'default' {
  return current === 'vim' ? 'default' : 'vim';
}

export function handleNormalKey(state: VimState, key: string): { state: VimState; action?: string } {
  if (state.mode !== 'normal') return { state };
  if (key === 'i') return { state: toInsert(state), action: 'insert' };
  if (key === 'a') return { state: toInsert(state), action: 'append' };
  if (key === 'escape') return { state };
  if (key === 'd') return { state: { mode: 'normal', pendingOperator: 'd' }, action: 'operator:d' };
  if (key === 'c') return { state: { mode: 'normal', pendingOperator: 'c' }, action: 'operator:c' };
  if (key === 'y') return { state: { mode: 'normal', pendingOperator: 'y' }, action: 'operator:y' };
  if (/^[0-9]$/.test(key) && key !== '0') {
    const c = (state.count ?? 0) * 10 + Number(key);
    return { state: { mode: 'normal', count: c }, action: `count:${c}` };
  }
  return { state };
}
