import React from 'react';
import { Box, Text, useIsScreenReaderEnabled } from 'ink';

export function StatusBar(props: {
  cwd?: string;
  tokens?: number;
  windowSize?: number;
  spend?: number;
  vimMode?: string;
  activity?: string;
  running?: boolean;
  hint?: string;
}): React.ReactElement {
  const { cwd, tokens, windowSize, spend, vimMode, activity, running, hint } = props;
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
  const pct = tokens !== undefined && windowSize ? ` (${Math.min(99, Math.round((tokens / windowSize) * 100))}%)` : '';
  const right = [
    tokens !== undefined ? `${fmt(tokens)}${pct}` : null,
    typeof spend === 'number' ? `$${spend.toFixed(2)}` : null,
    vimMode && vimMode !== 'insert' ? `vim:${vimMode}` : null,
    hint ?? null,
  ].filter((p): p is string => !!p).join(' · ');
  return React.createElement(
    Box,
    { justifyContent: 'space-between' },
    React.createElement(Text, { dimColor: !screenReader, wrap: 'truncate' }, cwd ?? ''),
    React.createElement(Text, { dimColor: !screenReader, wrap: 'truncate' }, `${running && activity ? `${activity} · ` : ''}${right}`),
  );
}
