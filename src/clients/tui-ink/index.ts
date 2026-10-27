import React from 'react';
import { render } from 'ink';
import { App } from './app.tsx';
import type { TuiArgs } from './args.ts';

export async function runInkTui(args: TuiArgs): Promise<number> {
  const { unmount, waitUntilExit } = render(React.createElement(App, { args }), { alternateScreen: true, exitOnCtrlC: false });
  process.on('SIGINT', () => { unmount(); process.exit(0); });
  await waitUntilExit();
  return 0;
}
