import type { RenderOptions } from 'ink';
import { envScreenReader } from './a11y.ts';

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
    // Honor CEDIA_*/INK_SCREEN_READER so Ink's own SR tree matches our layout flags.
    isScreenReaderEnabled: envScreenReader() || undefined,
    ...overrides,
  };
}
