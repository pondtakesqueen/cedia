import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// A living doc is a Markdown file that names itself with a `# LIVING DOC: <title>` line and
// keeps one section between LIVING markers that cedia may rewrite. Files written for the
// older names (`# MAGIC DOC:` and the MAGIC markers) are still found and updated.
export type LivingDoc = { path: string; title: string; header: string };

const HEADER_RE = /^#\s*(?:LIVING|MAGIC) DOC:\s*(.+)$/m;
const MARKERS = [
  { start: '<!-- LIVING:START -->', end: '<!-- LIVING:END -->' },
  { start: '<!-- MAGIC:START -->', end: '<!-- MAGIC:END -->' },
];

export function findLivingDocs(root: string): LivingDoc[] {
  const out: LivingDoc[] = [];
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

// Where the rewritable section is: `inner` is just after the start marker, `end` just after
// the end marker. The LIVING markers win when a file has both.
export function livingSection(text: string): { start: number; inner: number; close: number; end: number } | undefined {
  for (const m of MARKERS) {
    const i = text.indexOf(m.start);
    const j = text.indexOf(m.end);
    if (i >= 0 && j >= 0 && j > i) return { start: i, inner: i + m.start.length, close: j, end: j + m.end.length };
  }
  return undefined;
}

export function updateLivingSection(path: string, content: string): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  const s = livingSection(text);
  if (!s) return false;
  writeFileSync(path, text.slice(0, s.inner) + '\n' + content.trim() + '\n' + text.slice(s.close));
  return true;
}

export function relativeLivingDocs(root: string): LivingDoc[] {
  return findLivingDocs(root).map((d) => ({ ...d, path: relative(root, d.path) }));
}
