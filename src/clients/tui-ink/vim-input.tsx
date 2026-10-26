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
    // normal mode (simplified)
    if (input === 'i') { setVimMode('insert'); return; }
    if (key.return) { onSubmit(value); return; }
  });

  if (vimMode === 'insert') {
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
