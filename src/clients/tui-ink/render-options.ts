import type { RenderOptions } from 'ink';

/** Ink render options for the interactive cedia TUI. */
export function inkRenderOptions(overrides: RenderOptions = {}): RenderOptions {
  return {
    alternateScreen: true,
    exitOnCtrlC: false,
    // Line-level Frame-diff: only rewrite changed rows (and safe prefixes).
    incrementalRendering: true,
    // Cap Yoga/commit cadence; 60 keeps streaming text responsive without full-speed thrash.
    maxFps: 60,
    patchConsole: true,
    ...overrides,
  };
}
