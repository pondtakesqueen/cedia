import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type MagicDoc = { path: string; title: string; header: string };

const HEADER_RE = /^#\s*MAGIC DOC:\s*(.+)$/m;
const START = '<!-- MAGIC:START -->';
const END = '<!-- MAGIC:END -->';

export function findMagicDocs(root: string): MagicDoc[] {
  const out: MagicDoc[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git') continue;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && (e.endsWith('.md') || e.endsWith('.mdx'))) {
        try {
          const text = readFileSync(p, 'utf8');
          const m = HEADER_RE.exec(text);
          if (m) out.push({ path: p, title: m[1]!.trim(), header: m[0] });
        } catch {
          // skip
        }
      }
    }
  };
  walk(root);
  return out;
}

export function updateMagicSection(path: string, content: string): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i < 0 || j < 0 || j < i) return false;
  const next = text.slice(0, i + START.length) + '\n' + content.trim() + '\n' + text.slice(j);
  writeFileSync(path, next);
  return true;
}

export function magicSection(text: string): { start: number; end: number } | undefined {
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i < 0 || j < 0 || j < i) return undefined;
  return { start: i, end: j + END.length };
}

export function relativeMagicDocs(root: string): MagicDoc[] {
  return findMagicDocs(root).map((d) => ({ ...d, path: relative(root, d.path) }));
}
