import React from 'react';
import { render } from 'ink';
import { App } from './app.tsx';
import type { TuiArgs } from '../tui/main.ts';

export function runInkTui(args: TuiArgs): void {
  const { unmount } = render(React.createElement(App, { args }), { alternateScreen: true });
  // keep process alive; App handles exit
  process.on('SIGINT', () => { unmount(); process.exit(0); });
}
