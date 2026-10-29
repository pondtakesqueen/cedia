import React from 'react';
import { render } from 'ink';
import { App } from './app.tsx';
import type { TuiArgs } from './args.ts';
import { inkRenderOptions } from './render-options.ts';
import { attachSigcontRedraw } from './terminal-resume.ts';
import { setTerminalTheme, themeSetting } from './theme-tokens.ts';
import { queryTerminalTheme } from './terminal-theme.ts';
import { cediaHome } from '../../core/config.ts';

export async function runInkTui(args: TuiArgs): Promise<number> {
  // Without a theme in settings, the terminal's background picks one.
  if (!themeSetting(cediaHome())) setTerminalTheme(await queryTerminalTheme(process.stdin, process.stdout));
  const { unmount, waitUntilExit, clear } = render(
    React.createElement(App, { args }),
    inkRenderOptions(),
  );
  const detachSigcont = attachSigcontRedraw(clear);
  process.on('SIGINT', () => {
    detachSigcont();
    unmount();
    process.exit(0);
  });
  try {
    await waitUntilExit();
  } finally {
    detachSigcont();
  }
  return 0;
}
