import React from 'react';
import { Text, useIsScreenReaderEnabled } from 'ink';

export function StatusBar(props: {
  thread?: string;
  model?: string;
  permission?: string;
  running: boolean;
  context?: number;
  spend?: number;
  vimMode?: string;
  activity?: string;
}): React.ReactElement {
  const { thread, model, permission, running, context, spend, vimMode, activity } = props;
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';
  // One subtle line, like cc's bottom status row (no boxes, no segments).
  const parts = [
    activity && running ? activity : null,
    model ?? 'auto',
    permission ?? 'auto',
    thread ?? 'new thread',
    context ? `ctx ${Math.round(context / 1000)}k` : null,
    typeof spend === 'number' ? `$${spend.toFixed(4)}` : null,
    vimMode && vimMode !== 'insert' ? `vim:${vimMode}` : null,
  ].filter((p): p is string => !!p);
  return React.createElement(
    Text,
    { dimColor: !screenReader, wrap: 'truncate' },
    running ? `● ${parts.join(' · ')}` : parts.join(' · '),
  );
}
