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
  agents?: number;
}): React.ReactElement {
  const { model, permission, running, context, spend, activity, agents } = props;
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';
  const modeLabel =
    permission === 'workspace' ? 'workspace mode on'
    : permission === 'read-only' ? 'read-only mode on'
    : permission === 'plan' ? 'plan mode on'
    : 'auto mode on';
  const agentN = agents ?? 0;
  const extra = [
    model && model !== 'auto' ? model : null,
    context ? `ctx ${Math.round(context / 1000)}k` : null,
    typeof spend === 'number' ? `$${spend.toFixed(4)}` : null,
  ].filter((p): p is string => !!p);
  const line = `▶▶ ${activity && running ? `${activity} · ` : ''}${modeLabel}${extra.length ? ` · ${extra.join(' · ')}` : ''} · ← ${agentN} agent${agentN === 1 ? '' : 's'}`;
  return React.createElement(
    Text,
    { dimColor: !screenReader, wrap: 'truncate' },
    line,
  );
}
