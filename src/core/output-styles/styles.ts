import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome } from '../config.ts';

export type OutputStyle = { name: string; description: string; promptModifier: string };

const BUILTIN: OutputStyle[] = [
  { name: 'default', description: 'Default coding assistant', promptModifier: '' },
  { name: 'explanatory', description: 'Explain reasoning and tradeoffs', promptModifier: 'Explain your reasoning and the tradeoffs behind each change.' },
  { name: 'learning', description: 'Teach as you go', promptModifier: 'Teach the concepts as you make changes; highlight why.' },
];

export function stylesDir(home = cediaHome()) { return join(home, 'output-styles'); }

export function loadOutputStyles(home = cediaHome()): OutputStyle[] {
  const out = [...BUILTIN];
  const dir = stylesDir(home);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      try {
        const raw = readFileSync(join(dir, f), 'utf8');
        const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
        let name = f.replace(/\.md$/, '');
        let desc = '';
        let body = raw;
        if (m) {
          const fm = m[1]!;
          body = m[2]!;
          const n = /^name:\s*(.+)$/m.exec(fm); if (n) name = n[1]!.trim();
          const d = /^description:\s*(.+)$/m.exec(fm); if (d) desc = d[1]!.trim();
        }
        out.push({ name, description: desc, promptModifier: body.trim() });
      } catch {}
    }
  }
  return out;
}

export function getStyle(name: string, home = cediaHome()): OutputStyle | undefined {
  return loadOutputStyles(home).find((s) => s.name === name);
}

export function loadOutputStyleSetting(home = cediaHome()): string {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    return raw?.outputStyle ?? 'default';
  } catch {
    return 'default';
  }
}
