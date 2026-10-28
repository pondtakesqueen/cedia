import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Design-token theme for the ink TUI (dark + light variants). Every color the TUI paints comes from here,
// markdown and code included. The palette is cedia's own: a sea-green brand, amber for work in progress, violet
// for thinking and plan mode. Status takes color (running, done, failed, mode); hierarchy takes weight and space.
// The TUI never paints the whole background: the terminal's own stays, and only rows that need a band get one.
// Hex values downsample to 256 or 16 colors where the terminal has no truecolor.
export type ThemeName = 'dark' | 'light';

export type ThemeTokens = {
  primary: string;
  secondary: string;
  accent: string;
  error: string;
  warning: string;
  success: string;
  info: string;
  text: string;
  textMuted: string;
  // Rules, borders at rest, hints: one step quieter than textMuted.
  textFaint: string;
  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  userRowBg: string;
  selectedBg: string;
  selectionBg: string;
  selectionFg: string;
  searchHitBg: string;
  searchHitFg: string;
  border: string;
  borderActive: string;
  diffAdded: string;
  diffRemoved: string;
  diffAddedBg: string;
  diffRemovedBg: string;
  diffContext: string;
  diffHunkHeader: string;
  // Thinking and plan mode.
  thinking: string;
  code: string;
  heading: string;
  link: string;
  synKeyword: string;
  synString: string;
  synComment: string;
  synNumber: string;
  synFunction: string;
};

const dark: ThemeTokens = {
  primary: '#5ec4b6',
  secondary: '#a69be8',
  accent: '#e5b567',
  error: '#e67e80',
  warning: '#e5b567',
  success: '#87c38a',
  info: '#5ec4b6',
  text: '#d7dae0',
  textMuted: '#7d8590',
  textFaint: '#4d5560',
  background: '#14171c',
  backgroundPanel: '#181c22',
  backgroundElement: '#1e232b',
  userRowBg: '#232831',
  selectedBg: '#2a3540',
  selectionBg: '#2f5f59',
  selectionFg: '#eef1f4',
  searchHitBg: '#e5b567',
  searchHitFg: '#14171c',
  border: '#4d5560',
  borderActive: '#5ec4b6',
  diffAdded: '#87c38a',
  diffRemoved: '#e67e80',
  diffAddedBg: '#1c3326',
  diffRemovedBg: '#3a2227',
  diffContext: '#7d8590',
  diffHunkHeader: '#5ec4b6',
  thinking: '#a69be8',
  code: '#8fd3c8',
  heading: '#e9ecf1',
  link: '#7cc4e8',
  synKeyword: '#a69be8',
  synString: '#a8cf8e',
  synComment: '#6a727e',
  synNumber: '#e5b567',
  synFunction: '#7cc4e8',
};

const light: ThemeTokens = {
  primary: '#13877a',
  secondary: '#6b5bc4',
  accent: '#a86a12',
  error: '#c4414a',
  warning: '#a86a12',
  success: '#3f7f45',
  info: '#13877a',
  text: '#2b2f36',
  textMuted: '#6a717c',
  textFaint: '#a9b0b9',
  background: '#fbfbfa',
  backgroundPanel: '#f3f4f5',
  backgroundElement: '#e9ebee',
  userRowBg: '#eceff3',
  selectedBg: '#dbe8ec',
  selectionBg: '#bfe0da',
  selectionFg: '#15181d',
  searchHitBg: '#a86a12',
  searchHitFg: '#fbfbfa',
  border: '#a9b0b9',
  borderActive: '#13877a',
  diffAdded: '#3f7f45',
  diffRemoved: '#c4414a',
  diffAddedBg: '#e1f2e4',
  diffRemovedBg: '#f8e1e3',
  diffContext: '#6a717c',
  diffHunkHeader: '#13877a',
  thinking: '#6b5bc4',
  code: '#0f6f64',
  heading: '#15181d',
  link: '#1d6fa5',
  synKeyword: '#6b5bc4',
  synString: '#3f7f45',
  synComment: '#8a919b',
  synNumber: '#a86a12',
  synFunction: '#1d6fa5',
};

export const INK_THEMES: Record<ThemeName, ThemeTokens> = { dark, light };

// A terminal with 256 colors gets each hex mapped to a palette entry, and the faint tints of the bands above
// all land on the same mid grey. There the bands take values that map to chosen entries instead: greys exactly,
// and #003300 / #330000 / #003333, which the mapping (a linear 0-5 scale per channel) sends to entries 22, 52
// and 23 (#005f00, #5f0000, #005f5f).
const BANDS_256: Record<ThemeName, Partial<ThemeTokens>> = {
  dark: { background: '#1c1c1c', userRowBg: '#262626', selectedBg: '#303030', diffAddedBg: '#003300', diffRemovedBg: '#330000', selectionBg: '#003333' },
  light: { background: '#ffffff', userRowBg: '#eeeeee', selectedBg: '#dadada', diffAddedBg: '#d7ffd7', diffRemovedBg: '#ffd7d7', selectionBg: '#afd7d7' },
};

/** Whether the terminal shows 24-bit color, by the same signals supports-color reads. */
export function truecolor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return true;
  if (/-direct$|^xterm-kitty$|^xterm-ghostty$/.test(env.TERM ?? '')) return true;
  return ['iTerm.app', 'WezTerm', 'ghostty', 'vscode'].includes(env.TERM_PROGRAM ?? '');
}

export function tokensFor(name: ThemeName, env: NodeJS.ProcessEnv = process.env): ThemeTokens {
  return truecolor(env) ? INK_THEMES[name] : { ...INK_THEMES[name], ...BANDS_256[name] };
}

export function resolveThemeName(raw: unknown): ThemeName {
  return raw === 'light' ? 'light' : 'dark';
}

export function inkTheme(home: string): { name: ThemeName; tokens: ThemeTokens } {
  try {
    const p = join(home, 'settings.json');
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as { theme?: unknown };
      const name = resolveThemeName(raw.theme);
      return { name, tokens: tokensFor(name) };
    }
  } catch {}
  return { name: 'dark', tokens: tokensFor('dark') };
}
