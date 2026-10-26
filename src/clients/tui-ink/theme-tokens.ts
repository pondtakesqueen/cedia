import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Design-token theme for the ink TUI (dark + light variants).
// Token categories follow the common convention (primary/text/background/
// border/diff/markdown/syntax); all hex values here are original to cedia.
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
  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  userRowBg: string;
  selectedBg: string;
  border: string;
  borderActive: string;
  diffAdded: string;
  diffRemoved: string;
  diffContext: string;
  diffHunkHeader: string;
  code: string;
  heading: string;
  link: string;
};

const dark: ThemeTokens = {
  primary: '#7aa2f7',
  secondary: '#bb9af7',
  accent: '#ff9e64',
  error: '#f7768e',
  warning: '#e0af68',
  success: '#9ece6a',
  info: '#7aa2f7',
  text: '#c0caf5',
  textMuted: '#565f89',
  background: '#1a1b26',
  backgroundPanel: '#16161e',
  backgroundElement: '#1f2335',
  userRowBg: '#343a58',
  selectedBg: '#28344a',
  border: '#3b4261',
  borderActive: '#7aa2f7',
  diffAdded: '#9ece6a',
  diffRemoved: '#f7768e',
  diffContext: '#565f89',
  diffHunkHeader: '#7aa2f7',
  code: '#9ece6a',
  heading: '#bb9af7',
  link: '#7dcfff',
};

const light: ThemeTokens = {
  primary: '#2e7de9',
  secondary: '#9854f1',
  accent: '#b15c00',
  error: '#f52a65',
  warning: '#8c6c3e',
  success: '#587539',
  info: '#2e7de9',
  text: '#343b58',
  textMuted: '#9699a8',
  background: '#e1e2e7',
  backgroundPanel: '#d5d6db',
  backgroundElement: '#c8c9ce',
  userRowBg: '#d5d6db',
  selectedBg: '#c8d5e8',
  border: '#9699a8',
  borderActive: '#2e7de9',
  diffAdded: '#587539',
  diffRemoved: '#f52a65',
  diffContext: '#9699a8',
  diffHunkHeader: '#2e7de9',
  code: '#587539',
  heading: '#9854f1',
  link: '#007197',
};

export const INK_THEMES: Record<ThemeName, ThemeTokens> = { dark, light };

export function resolveThemeName(raw: unknown): ThemeName {
  return raw === 'light' ? 'light' : 'dark';
}

export function inkTheme(home: string): { name: ThemeName; tokens: ThemeTokens } {
  try {
    const p = join(home, 'settings.json');
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as { theme?: unknown };
      const name = resolveThemeName(raw.theme);
      return { name, tokens: INK_THEMES[name] };
    }
  } catch {}
  return { name: 'dark', tokens: dark };
}
