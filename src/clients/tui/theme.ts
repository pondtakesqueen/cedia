export type Theme = 'dark' | 'light';

export const palette = {
  dark: {
    bg: '#1e1e1e', fg: '#d4d4d4', accent: '#569cd6', warning: '#dcdcaa', error: '#f44747', success: '#6a9955', muted: '#808080', border: '#3c3c3c',
  },
  light: {
    bg: '#ffffff', fg: '#000000', accent: '#007acc', warning: '#b8860b', error: '#cd3131', success: '#107c10', muted: '#6a737d', border: '#e1e4e8',
  },
};

export const borders = {
  rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  sharp: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
};

export const spacing = { xs: 1, sm: 2, md: 4, lg: 8 };

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function loadTheme(home?: string): Theme {
  const base = home ?? process.env.CEDIA_HOME ?? (process.env.HOME + '/.cedia');
  const candidates: string[] = [];
  if (base.endsWith('.cedia')) {
    candidates.push(join(base, 'settings.json'));
    candidates.push(join(base, '.cedia', 'settings.json'));
  } else {
    candidates.push(join(base, 'settings.json'));
    candidates.push(join(base, '.cedia', 'settings.json'));
  }
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      return raw?.theme === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }
  return 'dark';
}