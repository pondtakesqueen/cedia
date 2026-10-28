import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { yankText, yankedText } from './yank.ts';
import { isTextObjectChar, textObjectRange, type TextObjectKind } from './vim-textobject.ts';
import { backspace, deleteForward, insert, normalizePaste, killToLineEnd, killToLineStart, killWordBack, killWordForward, lineEnd, lineStart, nextStop, prevStop, typed, wordLeft, wordRight, type Edit } from './line-edit.ts';

export type VimMode = 'insert' | 'normal' | 'visual' | 'vline';

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  vimMode: VimMode;
  setVimMode: (m: VimMode) => void;
  /** When an overlay owns the keyboard, ignore all keys. */
  captured?: boolean;
  /** The app consumed Enter itself (accepting a dropdown item): don't submit the stale text. */
  suppressSubmit?: boolean;
  /** What a paste puts in the prompt: the app may stand a token in for a long one. */
  onPaste?: (text: string) => string;
};

/** Character range selected in visual; whole lines in vline (end exclusive). */
export function visualSpan(value: string, mode: VimMode, anchor: number, cursor: number): { lo: number; hi: number } | null {
  if (mode !== 'visual' && mode !== 'vline') return null;
  const a = Math.min(anchor, cursor);
  const b = Math.max(anchor, cursor);
  if (mode === 'visual') return { lo: a, hi: Math.min(value.length, b + 1) };
  const start = a === 0 ? 0 : value.lastIndexOf('\n', a - 1) + 1;
  let end = value.indexOf('\n', b);
  end = end < 0 ? value.length : end + 1;
  return { lo: start, hi: end };
}

export function VimInput({ value, onChange, onSubmit, placeholder, vimMode, setVimMode, captured, suppressSubmit, onPaste }: Props): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const lastVal = useRef(value);
  // What the keys edit. Keys read and write these, not the props: several keys in one stdin chunk (a held
  // backspace, fast typing) run before React renders again, and each must see the edit the one before it made.
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  // A value the app set itself (history, a completion, the editor) replaces the text: the cursor goes to its end.
  const external = value !== valueRef.current;
  valueRef.current = value;
  // Record each discrete value for text undo (ctrl+_).
  useEffect(() => {
    if (lastVal.current !== value) {
      const prev = lastVal.current;
      lastVal.current = value;
      setUndoStack((s) => (s[s.length - 1] === prev ? s : [...s.slice(-49), prev]));
    }
    setCursor((c) => (external ? value.length : Math.max(0, Math.min(c, value.length))));
  }, [value]);
  const [pendingOp, setPendingOp] = useState<'d' | 'c' | 'y' | null>(null);
  const [pendingTextObject, setPendingTextObject] = useState<TextObjectKind | null>(null);
  const [count, setCount] = useState<number | null>(null);

  const clamp = (n: number) => Math.max(0, Math.min(n, value.length));
  const put = (next: Edit) => {
    if (next.value !== valueRef.current) { valueRef.current = next.value; onChange(next.value); }
    cursorRef.current = next.cursor;
    setCursor(next.cursor);
  };

  // Bracketed paste: a pasted block arrives whole, newlines and all, and never submits.
  usePaste((raw) => {
    const text = typed(normalizePaste(raw));
    if (!text) return;
    // A tab paints at no fixed width in the prompt; a long paste's token keeps the text as it came.
    const shown = (onPaste ? onPaste(text) : text).replace(/\t/g, '    ');
    put(insert({ value: valueRef.current, cursor: Math.min(cursorRef.current, valueRef.current.length) }, shown));
  }, { isActive: !captured });

  useInput((input, key) => {
    if (captured) return;
    // Text undo (like readline ctrl+_ / ctrl+shift+-).
    if (key.ctrl && (input === '_' || input === '\x1f' || (input === '-' && key.shift))) {
      setUndoStack((s) => {
        const top = s[s.length - 1];
        if (top === undefined) return s;
        onChange(top);
        setCursor(Math.min(cursor, Math.max(0, top.length)));
        return s.slice(0, -1);
      });
      return;
    }
    if (vimMode === 'insert') {
      // Esc is handled by App (abort when running, else normal mode).
      // Keys read and write the refs, not the props: several keys in one stdin chunk (a held backspace, fast
      // typing) run before React renders again, and each must see the edit the one before it made.
      const e: Edit = { value: valueRef.current, cursor: Math.min(cursorRef.current, valueRef.current.length) };
      // Batched input handling
      if (input && input.length > 1 && (input.includes('\r') || input.includes('\n')) && !key.ctrl && !key.meta) {
        const nl = input.search(/[\r\n]/);
        const next = insert(e, typed(input.slice(0, nl)));
        if (next !== e) put(next);
        if (suppressSubmit && input[nl] === '\r') return;
        // Trailing backslash + Enter inserts a newline instead of submitting.
        if (input[nl] === '\r' && next.value.endsWith('\\') && next.cursor >= next.value.length) {
          put({ value: next.value.slice(0, -1) + '\n', cursor: next.value.length });
        } else { put({ value: next.value, cursor: 0 }); onSubmit(next.value); }
        return;
      }
      // alt+enter (and shift+enter where the terminal tells it apart, or sends it as alt+enter) and ctrl+j: a newline.
      if ((key.return && (key.meta || key.shift)) || input === '\n') { put(insert(e, '\n')); return; }
      if (key.return && !suppressSubmit) {
        // Trailing backslash + Enter inserts a newline instead of submitting.
        if (e.value.endsWith('\\') && e.cursor === e.value.length) {
          put({ value: e.value.slice(0, -1) + '\n', cursor: e.value.length });
          return;
        }
        onSubmit(e.value); return;
      }
      if (key.backspace && key.meta) { put(killWordBack(e)); return; }
      if (key.backspace) { put(backspace(e)); return; }
      // Delete and ctrl+d erase forward (on an empty prompt the app takes ctrl+d to leave).
      if (key.delete || (key.ctrl && input === 'd')) { put(deleteForward(e)); return; }
      if (key.ctrl && input === 'a') { put({ ...e, cursor: lineStart(e.value, e.cursor) }); return; }
      if (key.ctrl && input === 'e') { put({ ...e, cursor: lineEnd(e.value, e.cursor) }); return; }
      if (key.ctrl && input === 'u') { put(killToLineStart(e)); return; }
      if (key.ctrl && input === 'k') { put(killToLineEnd(e)); return; }
      if (key.ctrl && input === 'w') { put(killWordBack(e)); return; }
      if (key.meta && input === 'd') { put(killWordForward(e)); return; }
      if ((key.meta && input === 'b') || ((key.ctrl || key.meta) && key.leftArrow)) { put({ ...e, cursor: wordLeft(e.value, e.cursor) }); return; }
      if ((key.meta && input === 'f') || ((key.ctrl || key.meta) && key.rightArrow)) { put({ ...e, cursor: wordRight(e.value, e.cursor) }); return; }
      if (key.leftArrow) { put({ ...e, cursor: prevStop(e.value, e.cursor) }); return; }
      if (key.rightArrow) { put({ ...e, cursor: nextStop(e.value, e.cursor) }); return; }
      if (key.upArrow || key.downArrow) {
        // Multiline: move the cursor by visual row (like cc). Single-line:
        // do nothing here — the app owns Up/Down for prompt history.
        if (e.value.includes('\n')) {
          const pos0 = locate(e.cursor, e.value);
          const nr = pos0.row + (key.upArrow ? -1 : 1);
          if (nr >= 0 && nr < pos0.lines.length) {
            let acc = 0;
            for (let i = 0; i < nr; i++) acc += pos0.lines[i]!.length + 1;
            put({ ...e, cursor: acc + Math.min(pos0.col, pos0.lines[nr]!.length) });
          } else put({ ...e, cursor: key.upArrow ? 0 : e.value.length });
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const text = typed(input);
        if (text) put(insert(e, text));
      }
      return;
    }
    // normal mode (app-level ctrl/meta shortcuts take precedence)
    if (key.ctrl || key.meta) return;
    if (/^[1-9]$/.test(input)) { setCount((c) => (c ?? 0) * 10 + Number(input)); return; }
    const n = count ?? 1;
    setCount(null);
    // visual / vline: motions extend the selection from the anchor
    if (vimMode === 'visual' || vimMode === 'vline') {
      if (key.escape || input === 'v' || input === 'V') { setVimMode('normal'); setAnchor(null); return; }
      if (input === 'y') {
        const span = visualSpan(value, vimMode, anchor ?? cursor, cursor);
        if (span) yankText(value.slice(span.lo, span.hi));
        setVimMode('normal');
        setAnchor(null);
        return;
      }
      if (input === 'd' || input === 'c' || input === 'x') {
        const span = visualSpan(value, vimMode, anchor ?? cursor, cursor);
        if (span) {
          onChange(value.slice(0, span.lo) + value.slice(span.hi));
          setCursor(Math.min(span.lo, Math.max(0, value.length - (span.hi - span.lo))));
        }
        setAnchor(null);
        if (input === 'c') setVimMode('insert');
        else setVimMode('normal');
        return;
      }
      // fall through to the shared motions below (they move the cursor)
    }
    // With a pending operator, i/a start a text object (diw, ci", …) instead of insert/append.
    if (input === 'i' && !pendingOp) { if (vimMode === 'visual' || vimMode === 'vline') { setAnchor(null); } setVimMode('insert'); return; }
    if (input === 'a' && vimMode === 'normal' && !pendingOp) { setCursor(Math.min(cursor + 1, value.length)); setVimMode('insert'); return; }
    if (input === 'v' && vimMode === 'normal') { setAnchor(cursor); setVimMode('visual'); return; }
    if (input === 'V' && vimMode === 'normal') { setAnchor(cursor); setVimMode('vline'); return; }
    if ((input === 'p' || input === 'P') && vimMode === 'normal') {
      const text = yankedText();
      if (!text) return;
      if (input === 'p') {
        const at = Math.min(cursor + 1, value.length);
        onChange(value.slice(0, at) + text + value.slice(at));
        setCursor(at + text.length - (text.endsWith('\n') ? 1 : 0));
      } else {
        onChange(value.slice(0, cursor) + text + value.slice(cursor));
        setCursor(cursor + text.length - (text.endsWith('\n') ? 1 : 0));
      }
      return;
    }
    if (key.return && !suppressSubmit) { onSubmit(value); return; }
    // motions
    const move = (fn: (c: number) => number) => {
      let nc = cursor;
      for (let i = 0; i < n; i++) nc = fn(nc);
      setCursor(Math.max(0, Math.min(nc, Math.max(0, value.length - 1))));
    };
    // Arrow keys move like hjkl (cc parity: arrows always move the cursor).
    if (key.leftArrow) { move((c) => c - 1); return; }
    if (key.rightArrow) { move((c) => c + 1); return; }
    if (key.upArrow || key.downArrow) {
      const pos0 = locate(Math.min(cursor, Math.max(0, value.length - 1)));
      const nr = pos0.row + (key.upArrow ? -n : n);
      if (nr >= 0 && nr < pos0.lines.length) {
        let acc = 0;
        for (let i = 0; i < nr; i++) acc += pos0.lines[i]!.length + 1;
        setCursor(acc + Math.min(pos0.col, pos0.lines[nr]!.length));
      } else setCursor(key.upArrow ? 0 : value.length);
      return;
    }
    const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
    const nextWord = (c: number) => {
      let i = c;
      while (i < value.length && isWord(value[i]!)) i++;
      while (i < value.length && !isWord(value[i]!)) i++;
      return i;
    };
    const prevWord = (c: number) => {
      let i = c;
      if (i > 0) i--;
      while (i > 0 && !isWord(value[i]!)) i--;
      while (i > 0 && isWord(value[i - 1]!)) i--;
      return i;
    };
    const endWord = (c: number) => {
      let i = c;
      while (i < value.length - 1 && isWord(value[i + 1]!)) i++;
      return i;
    };
    if (input === 'h') { move((c) => c - 1); return; }
    if (input === 'l') { move((c) => c + 1); return; }
    if (input === 'w') { move(nextWord); return; }
    if (input === 'b') { move(prevWord); return; }
    if (input === 'e') { move(endWord); return; }
    if (input === '0') { if (count) setCount(count * 10); else setCursor(0); return; }
    if (input === 'j' || input === 'k') {
      const pos0 = locate(cursor);
      const nr = pos0.row + (input === 'j' ? n : -n);
      if (nr >= 0 && nr < pos0.lines.length) {
        let acc = 0;
        for (let i = 0; i < nr; i++) acc += pos0.lines[i]!.length + 1;
        setCursor(acc + Math.min(pos0.col, pos0.lines[nr]!.length));
      } else setCursor(input === 'j' ? value.length : 0);
      return;
    }
    if (input === '$') { setCursor(Math.max(0, value.length - 1)); return; }
    const applyRange = (op: 'd' | 'c' | 'y', start: number, end: number) => {
      if (end <= start) return;
      if (op === 'y') {
        yankText(value.slice(start, end));
        return;
      }
      onChange(value.slice(0, start) + value.slice(end));
      setCursor(Math.min(start, Math.max(0, value.length - (end - start))));
      if (op === 'c') setVimMode('insert');
    };
    if (input === 'd' || input === 'c' || input === 'y') {
      setPendingOp(input as 'd' | 'c' | 'y');
      setPendingTextObject(null);
      return;
    }
    // operator + text object lead-in (di… / da… / ci… / …)
    if (pendingOp && !pendingTextObject && (input === 'i' || input === 'a')) {
      setPendingTextObject(input);
      return;
    }
    if (pendingOp && pendingTextObject && isTextObjectChar(input)) {
      const op = pendingOp;
      const kind = pendingTextObject;
      setPendingOp(null);
      setPendingTextObject(null);
      const span = textObjectRange(value, cursor, kind, input);
      if (span) applyRange(op, span.lo, span.hi);
      return;
    }
    // operator pending: apply to motion
    if (pendingOp && !pendingTextObject && (input === 'w' || input === 'b' || input === 'e' || input === 'h' || input === 'l' || input === '0' || input === '$')) {
      const op = pendingOp;
      setPendingOp(null);
      const motions: Record<string, (c: number) => number> = { h: (c) => c - 1, l: (c) => c + 1, w: nextWord, b: prevWord, e: endWord, '0': () => 0, '$': () => Math.max(0, value.length - 1) };
      const fn = motions[input];
      if (fn) {
        let nc = cursor;
        for (let i = 0; i < n; i++) nc = fn(nc);
        let start = Math.min(cursor, nc);
        let end = Math.max(cursor, nc);
        if (input === 'w' || input === 'e') end = Math.min(value.length, end + 1);
        applyRange(op, start, end);
      }
      return;
    }
    // dd/cc/yy
    if (pendingOp && !pendingTextObject && input === pendingOp) {
      const op = pendingOp;
      setPendingOp(null);
      if (op === 'y') { yankText(value); }
      else if (op === 'd') { onChange(''); setCursor(0); }
      else if (op === 'c') { onChange(''); setCursor(0); setVimMode('insert'); }
      return;
    }
    if (input === 'x') { onChange(value.slice(0, cursor) + value.slice(cursor + 1)); return; }
    // Anything unhandled clears a stale operator (d/c/y followed by nothing).
    if (pendingOp) {
      setPendingOp(null);
      setPendingTextObject(null);
    }
  });

  // Map a flat offset to row/col for multiline values.
  const locate = (off: number, text: string = value) => {
    const lines = text.split('\n');
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i]!.length;
      if (off <= acc + len || i === lines.length - 1) return { row: i, col: Math.min(off - acc, len), lines };
      acc += len + 1;
    }
    return { row: 0, col: 0, lines };
  };

  if (vimMode === 'insert') {
    if (!value && placeholder) {
      // Cursor sits on the first cell, over the placeholder's first letter (like cc).
      return (
        <Box>
          <Text inverse dimColor>{placeholder.slice(0, 1)}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Box>
      );
    }
    const pos = locate(cursor);
    return (
      <Box flexDirection="column">
        {pos.lines.map((ln, i) => {
          if (i !== pos.row) return <Text key={i}>{ln || ' '}</Text>;
          const after = nextStop(ln, pos.col);
          return (
            <Text key={i}>
              <Text>{ln.slice(0, pos.col)}</Text>
              <Text inverse>{ln.slice(pos.col, after) || ' '}</Text>
              <Text>{ln.slice(after)}</Text>
            </Text>
          );
        })}
      </Box>
    );
  }
  const c = Math.min(cursor, Math.max(0, value.length - 1));
  const npos = locate(c);
  // visual selection range, if active
  const span = anchor !== null ? visualSpan(value, vimMode, anchor, c) : null;
  const vlo = span?.lo ?? -1;
  const vhi = span?.hi ?? -1;
  let vacc = 0;
  const lineStarts: number[] = npos.lines.map((ln) => { const s = vacc; vacc += ln.length + 1; return s; });
  return (
    <Box flexDirection="column">
      {npos.lines.map((ln, i) => {
        const ls = lineStarts[i]!;
        const le = ls + ln.length;
        const oL = Math.max(vlo, ls) - ls;
        const oR = Math.min(vhi, le) - ls;
        if (vlo >= 0 && oL < oR) {
          const body = ln.slice(oL, oR) || ' ';
          return (
            <Text key={i}>
              <Text>{ln.slice(0, oL)}</Text>
              <Text inverse>{body}</Text>
              <Text>{ln.slice(oL + (ln.slice(oL, oR) ? oR - oL : 0))}</Text>
            </Text>
          );
        }
        const cc = i === npos.row ? Math.min(npos.col, Math.max(0, ln.length - 1)) : -1;
        if (cc < 0) return <Text key={i}>{ln || ' '}</Text>;
        return (
          <Text key={i}>
            <Text>{ln.slice(0, cc)}</Text>
            <Text inverse>{ln[cc] ?? ' '}</Text>
            <Text>{ln.slice(cc + 1)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
