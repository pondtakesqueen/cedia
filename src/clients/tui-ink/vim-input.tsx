import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  vimMode: 'insert' | 'normal' | 'visual';
  setVimMode: (m: 'insert' | 'normal' | 'visual') => void;
  /** When an overlay owns the keyboard, ignore all keys. */
  captured?: boolean;
};

export function VimInput({ value, onChange, onSubmit, placeholder, vimMode, setVimMode, captured }: Props): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [pendingOp, setPendingOp] = useState<'d' | 'c' | 'y' | null>(null);
  const [count, setCount] = useState<number | null>(null);

  const clamp = (n: number) => Math.max(0, Math.min(n, value.length));

  useInput((input, key) => {
    if (captured) return;
    if (vimMode === 'insert') {
      // Esc is handled by App (abort when running, else normal mode).
      // Batched input handling
      if (input && (input.includes('\r') || input.includes('\n')) && !key.ctrl && !key.meta) {
        const nl = input.search(/[\r\n]/);
        const before = nl >= 0 ? input.slice(0, nl) : input;
        const v = value.slice(0, cursor) + before + value.slice(cursor);
        onChange(v);
        if (nl >= 0) {
          const atEnd = cursor + before.length >= v.length;
          // Trailing backslash + Enter inserts a newline instead of submitting.
          if (input[nl] === '\r' && v.endsWith('\\') && atEnd) {
            const nv = v.slice(0, -1) + '\n';
            onChange(nv);
            setCursor(nv.length);
          } else { setCursor(0); onSubmit(v); }
        } else setCursor(cursor + before.length);
        return;
      }
      if (key.return) {
        // Trailing backslash + Enter inserts a newline instead of submitting.
        if (value.endsWith('\\') && cursor === value.length) {
          onChange(value.slice(0, -1) + '\n');
          return;
        }
        onSubmit(value); return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) { onChange(value.slice(0, cursor - 1) + value.slice(cursor)); setCursor(cursor - 1); }
        return;
      }
      if (key.leftArrow) { setCursor(clamp(cursor - 1)); return; }
      if (key.rightArrow) { setCursor(clamp(cursor + 1)); return; }
      if (key.upArrow || key.downArrow) return;
      if (input && !key.ctrl && !key.meta) {
        const printable = input.replace(/[^\x20-\x7e]/g, '');
        if (printable) {
          onChange(value.slice(0, cursor) + printable + value.slice(cursor));
          setCursor(cursor + printable.length);
        }
      }
      return;
    }
    // normal mode
    if (/^[1-9]$/.test(input)) { setCount((c) => (c ?? 0) * 10 + Number(input)); return; }
    const n = count ?? 1;
    setCount(null);
    // visual mode: motions extend the selection from the anchor
    if (vimMode === 'visual') {
      if (key.escape || input === 'v') { setVimMode('normal'); setAnchor(null); return; }
      if (input === 'y') { setVimMode('normal'); setAnchor(null); return; }
      if (input === 'd' || input === 'c' || input === 'x') {
        const a = anchor ?? cursor;
        const lo = Math.min(a, cursor), hi = Math.max(a, cursor) + 1;
        onChange(value.slice(0, lo) + value.slice(Math.min(hi, value.length)));
        setCursor(Math.min(lo, Math.max(0, value.length - (hi - lo) - 1)));
        setAnchor(null);
        if (input === 'c') setVimMode('insert');
        else setVimMode('normal');
        return;
      }
      // fall through to the shared motions below (they move the cursor)
    }
    if (input === 'i') { if (vimMode === 'visual') { setAnchor(null); } setVimMode('insert'); return; }
    if (input === 'a' && vimMode !== 'visual') { setCursor(Math.min(cursor + 1, value.length)); setVimMode('insert'); return; }
    if (input === 'v' && vimMode === 'normal') { setAnchor(cursor); setVimMode('visual'); return; }
    if (key.return) { onSubmit(value); return; }
    // motions
    const move = (fn: (c: number) => number) => {
      let nc = cursor;
      for (let i = 0; i < n; i++) nc = fn(nc);
      setCursor(Math.max(0, Math.min(nc, Math.max(0, value.length - 1))));
    };
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
    if (input === '0') { setCursor(0); return; }
    if (input === '$') { setCursor(Math.max(0, value.length - 1)); return; }
    if (input === 'd' || input === 'c' || input === 'y') {
      // store pending operator in a ref-like via closure? Use state via setPendingOp
      setPendingOp(input as 'd' | 'c' | 'y');
      return;
    }
    // operator pending: apply to motion
    if (pendingOp && (input === 'w' || input === 'b' || input === 'e' || input === 'h' || input === 'l' || input === '0' || input === '$')) {
      const op = pendingOp;
      setPendingOp(null);
      // compute range
      let start = cursor, end = cursor;
      const motions: Record<string, (c: number) => number> = { h: (c) => c - 1, l: (c) => c + 1, w: nextWord, b: prevWord, e: endWord, '0': () => 0, '$': () => Math.max(0, value.length - 1) };
      const fn = motions[input];
      if (fn) {
        let nc = cursor;
        for (let i = 0; i < n; i++) nc = fn(nc);
        start = Math.min(cursor, nc); end = Math.max(cursor, nc);
        // for w/e include the end char
        if (input === 'w' || input === 'e') end = Math.min(value.length, end + 1);
        if (input === 'b') { /* b moves start back */ }
        if (op === 'd') {
          onChange(value.slice(0, start) + value.slice(end));
          setCursor(Math.min(start, value.length - 1 < 0 ? 0 : value.length - 1 >= 0 ? Math.min(start, Math.max(0, value.length - 1)) : 0));
        } else if (op === 'c') {
          onChange(value.slice(0, start) + value.slice(end));
          setCursor(start);
          setVimMode('insert');
        } else {
          // yank: do nothing visible (no clipboard integration here)
        }
      }
      return;
    }
    // dd/cc/yy
    if (pendingOp && input === pendingOp) {
      const op = pendingOp;
      setPendingOp(null);
      if (op === 'd') { onChange(''); setCursor(0); }
      else if (op === 'c') { onChange(''); setCursor(0); setVimMode('insert'); }
      return;
    }
    if (input === 'x') { onChange(value.slice(0, cursor) + value.slice(cursor + 1)); return; }
  });

  // Map a flat offset to row/col for multiline values.
  const locate = (off: number) => {
    const lines = value.split('\n');
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
      // Cursor sits on the first cell, over the placeholder (like cc).
      return (
        <Box>
          <Text inverse> </Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Box>
      );
    }
    const pos = locate(cursor);
    return (
      <Box flexDirection="column">
        {pos.lines.map((ln, i) => {
          if (i !== pos.row) return <Text key={i}>{ln || ' '}</Text>;
          return (
            <Text key={i}>
              <Text>{ln.slice(0, pos.col)}</Text>
              <Text inverse>{ln[pos.col] ?? ' '}</Text>
              <Text>{ln.slice(pos.col + 1)}</Text>
            </Text>
          );
        })}
      </Box>
    );
  }
  const c = Math.min(cursor, Math.max(0, value.length - 1));
  const npos = locate(c);
  // visual selection range, if active
  const vlo = vimMode === 'visual' && anchor !== null ? Math.min(anchor, c) : -1;
  const vhi = vimMode === 'visual' && anchor !== null ? Math.max(anchor, c) + 1 : -1;
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
