import React from 'react';
import { render } from 'ink';
import { App } from './app.tsx';
import type { TuiArgs } from './args.ts';
import { inkRenderOptions } from './render-options.ts';
import { attachSigcontRedraw } from './terminal-resume.ts';

export async function runInkTui(args: TuiArgs): Promise<number> {
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
