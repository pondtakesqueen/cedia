import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  vimMode: 'insert' | 'normal';
  setVimMode: (m: 'insert' | 'normal') => void;
};

export function VimInput({ value, onChange, onSubmit, placeholder, vimMode, setVimMode }: Props): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [pendingOp, setPendingOp] = useState<'d' | 'c' | 'y' | null>(null);
  const [count, setCount] = useState<number | null>(null);

  const clamp = (n: number) => Math.max(0, Math.min(n, value.length));

  useInput((input, key) => {
    if (vimMode === 'insert') {
      // Esc is handled by App (abort when running, else normal mode).
      // Batched input handling
      if (input && (input.includes('\r') || input.includes('\n')) && !key.ctrl && !key.meta) {
        const nl = input.search(/[\r\n]/);
        const before = nl >= 0 ? input.slice(0, nl) : input;
        const v = value.slice(0, cursor) + before + value.slice(cursor);
        onChange(v);
        if (nl >= 0) { setCursor(0); onSubmit(v); } else setCursor(cursor + before.length);
        return;
      }
      if (key.return) { onSubmit(value); return; }
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
    if (input === 'i') { setVimMode('insert'); return; }
    if (input === 'a') { setCursor(Math.min(cursor + 1, value.length)); setVimMode('insert'); return; }
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

  if (vimMode === 'insert') {
    if (!value && placeholder) {
      return (
        <Box>
          <Text dimColor>{placeholder}</Text>
          <Text inverse> </Text>
        </Box>
      );
    }
    return (
      <Box>
        <Text>{value.slice(0, cursor)}</Text>
        <Text inverse>{value[cursor] ?? ' '}</Text>
        <Text>{value.slice(cursor + 1)}</Text>
      </Box>
    );
  }
  const c = Math.min(cursor, Math.max(0, value.length - 1));
  return (
    <Box>
      <Text>{value.slice(0, c)}</Text>
      <Text inverse>{value[c] ?? ' '}</Text>
      <Text>{value.slice(c + 1)}</Text>
    </Box>
  );
}
