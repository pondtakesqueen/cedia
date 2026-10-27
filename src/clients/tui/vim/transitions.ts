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

// handleNormalKey returns an action string describing what to do:
//  - 'insert' / 'append'
//  - 'operator:d' etc (pending)
//  - 'motion:<name>' (h,l,w,b,e,0,$,gg,G) with count
//  - 'find:<f|F|t|T>:<pending>' (waiting for char)
//  - 'textobject:<i|a>:<w>' 
//  - 'delete:line', 'change:line', 'yank:line'
//  - 'repeat' (dot)
export function handleNormalKey(state: VimState, key: string): { state: VimState; action?: string } {
  if (state.mode !== 'normal') return { state };
  const count = state.count ?? 1;

  // counts
  if (/^[1-9]$/.test(key)) {
    const c = (state.count ?? 0) * 10 + Number(key);
    return { state: { mode: 'normal', count: c, pendingOperator: state.pendingOperator, pendingFind: state.pendingFind }, action: `count:${c}` };
  }
  if (key === '0' && state.count) {
    const c = state.count * 10;
    return { state: { mode: 'normal', count: c, pendingOperator: state.pendingOperator, pendingFind: state.pendingFind }, action: `count:${c}` };
  }

  // find pending: next key is the target char
  if (state.pendingFind) {
    const f = state.pendingFind;
    const op = state.pendingOperator;
    state = { mode: 'normal' };
    if (op) {
      return { state, action: `findop:${op}:${f}:${key}` };
    }
    return { state, action: `find:${f}:${key}` };
  }

  // operator pending + text object (i/a + w)
  if (state.pendingOperator && (key === 'i' || key === 'a')) {
    return { state: { mode: 'normal', pendingOperator: state.pendingOperator, textObject: key } as unknown as VimState, action: `textobject-pending:${state.pendingOperator}:${key}` };
  }
  // text object char (w)
  if ((state as { textObject?: string }).textObject && key === 'w') {
    const op = state.pendingOperator!;
    return { state: { mode: 'normal' }, action: `${op === 'd' ? 'delete' : op === 'c' ? 'change' : 'yank'}:textobject:${(state as unknown as { textObject: string }).textObject}w` };
  }

  // operators
  if (key === 'd' || key === 'c' || key === 'y') {
    // dd/cc/yy
    return { state: { mode: 'normal', pendingOperator: key as 'd' | 'c' | 'y' }, action: `operator:${key}` };
  }
  // if pending operator and same key again → line operation
  if (state.pendingOperator && key === state.pendingOperator) {
    const op = state.pendingOperator;
    return { state: { mode: 'normal' }, action: op === 'd' ? 'delete:line' : op === 'c' ? 'change:line' : 'yank:line' };
  }
  // operator + find
  if (state.pendingOperator && (key === 'f' || key === 'F' || key === 't' || key === 'T')) {
    return { state: { mode: 'normal', pendingOperator: state.pendingOperator, pendingFind: key as 'f' | 'F' | 't' | 'T' }, action: `find-pending:${key}` };
  }
  // operator + motion
  if (state.pendingOperator && 'hlwbje0$G'.includes(key)) {
    const op = state.pendingOperator;
    const motion = key === 'G' ? 'G' : key;
    return { state: { mode: 'normal' }, action: `${op === 'd' ? 'delete' : op === 'c' ? 'change' : 'yank'}:motion:${motion}:${count}` };
  }
  // operator + gg
  if (state.pendingOperator && key === 'g') {
    // wait for second g
    return { state: { mode: 'normal', pendingOperator: state.pendingOperator, pendingG: true } as unknown as VimState, action: 'pending-g' };
  }

  // find (no operator)
  if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
    return { state: { mode: 'normal', pendingFind: key as 'f' | 'F' | 't' | 'T' }, action: `find-pending:${key}` };
  }

  // motions (no operator)
  if (key === 'h') return { state: { mode: 'normal' }, action: `move:h:${count}` };
  if (key === 'l') return { state: { mode: 'normal' }, action: `move:l:${count}` };
  if (key === 'j') return { state: { mode: 'normal' }, action: `move:j:${count}` };
  if (key === 'k') return { state: { mode: 'normal' }, action: `move:k:${count}` };
  if (key === 'w') return { state: { mode: 'normal' }, action: `move:w:${count}` };
  if (key === 'b') return { state: { mode: 'normal' }, action: `move:b:${count}` };
  if (key === 'e') return { state: { mode: 'normal' }, action: `move:e:${count}` };
  if (key === '0') return { state: { mode: 'normal' }, action: `move:0:1` };
  if (key === '$') return { state: { mode: 'normal' }, action: `move:$:1` };
  if (key === 'G') return { state: { mode: 'normal' }, action: `move:G:1` };
  if (key === 'g') {
    return { state: { mode: 'normal', pendingG: true } as unknown as VimState, action: 'pending-g' };
  }
  // second g (gg)
  if ((state as { pendingG?: boolean }).pendingG && key === 'g') {
    return { state: { mode: 'normal' }, action: `move:gg:1` };
  }

  // insert/append
  if (key === 'i') return { state: toInsert(state), action: 'insert' };
  if (key === 'a') return { state: toInsert(state), action: 'append' };
  if (key === 'I') return { state: toInsert(state), action: 'insert-line-start' };
  if (key === 'A') return { state: toInsert(state), action: 'append-line-end' };
  if (key === 'o') return { state: toInsert(state), action: 'open-below' };
  if (key === 'O') return { state: toInsert(state), action: 'open-above' };

  // dot repeat
  if (key === '.') return { state: { mode: 'normal' }, action: 'repeat' };

  // undo
  if (key === 'u') return { state: { mode: 'normal' }, action: 'undo' };

  if (key === 'escape') return { state };

  return { state };
}
