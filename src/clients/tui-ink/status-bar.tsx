import React from 'react';
import { Box, Text } from 'ink';

export function StatusBar(props: {
  thread?: string;
  model?: string;
  permission?: string;
  running: boolean;
  context?: number;
  spend?: number;
}): React.ReactElement {
  const { thread, model, permission, running, context, spend } = props;
  return React.createElement(
    Box,
    { flexDirection: 'row', justifyContent: 'space-between', paddingX: 1 },
    React.createElement(Text, { dimColor: true }, thread ?? 'new thread'),
    React.createElement(Text, { color: running ? 'cyan' : 'gray' }, running ? 'working' : 'idle'),
    React.createElement(Text, { dimColor: true }, model ?? 'auto'),
    React.createElement(Text, { dimColor: true }, permission ?? 'auto'),
    context ? React.createElement(Text, { dimColor: true }, `ctx ${Math.round(context / 1000)}k`) : null,
    typeof spend === 'number' ? React.createElement(Text, { dimColor: true }, `$${spend.toFixed(4)}`) : null,
  );
}
