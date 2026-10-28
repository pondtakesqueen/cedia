import { useIsScreenReaderEnabled } from 'ink';

/** Env flags that force cedia's screen-reader layout (and Ink's when wired into render). */
export function envScreenReader(): boolean {
  return process.env.CEDIA_SCREEN_READER === '1'
    || process.env.CEDIA_AX_SCREEN_READER === '1'
    || process.env.INK_SCREEN_READER === 'true';
}

/** Ink's SR detection plus cedia's env overrides. */
export function useCediaScreenReader(): boolean {
  return useIsScreenReaderEnabled() || envScreenReader();
}

/** List selection chrome: glyph for sighted users, spoken "selected:" for SR. */
export function selectedPrefix(selected: boolean, screenReader: boolean): string {
  if (screenReader) return selected ? 'selected: ' : '';
  return selected ? '› ' : '  ';
}
