import React from 'react';
import { Box, Text, useIsScreenReaderEnabled } from 'ink';

export function StatusBar(props: {
  thread?: string;
  model?: string;
  permission?: string;
  running: boolean;
  context?: number;
  spend?: number;
}): React.ReactElement {
  const { thread, model, permission, running, context, spend } = props;
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';
  return React.createElement(
    Box,
    { flexDirection: 'row', justifyContent: 'space-between', paddingX: 1 },
    React.createElement(Text, { dimColor: !screenReader }, thread ?? 'new thread'),
    React.createElement(Text, { color: screenReader ? undefined : (running ? 'cyan' : 'gray') }, running ? 'working' : 'idle'),
    React.createElement(Text, { dimColor: !screenReader }, model ?? 'auto'),
    React.createElement(Text, { dimColor: !screenReader }, permission ?? 'auto'),
    context ? React.createElement(Text, { dimColor: !screenReader }, `ctx ${Math.round(context / 1000)}k`) : null,
    typeof spend === 'number' ? React.createElement(Text, { dimColor: !screenReader }, `$${spend.toFixed(4)}`) : null,
  );
}
