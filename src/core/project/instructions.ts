import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { inert } from '../trust/frame.ts';

// The repository's own instructions for agents: an AGENTS.md (or, where a directory has none, a CLAUDE.md) in each
// directory from the repository's root down to the working directory, root first, so the nearer file reads last
// and wins where they differ. A line that is only `@path` brings in that file (CLAUDE.md here is `@AGENTS.md`).
//
// They go in the session's first user turn with the environment, never the cached system prompt, so the system
// prompt stays one across repositories. They are the repository's words, not the user's: an import may only name
// a file inside the repository (a symlink out of it counts as outside), so a cloned repo cannot pull ~/.ssh into
// the context, and the text is made inert so it cannot close a frame and speak as cedia. The sandbox and the deny
// list still decide what a call may do whatever the file says.

export type InstructionFile = { path: string; text: string };

export const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md'];
// The most the files may take of the first turn, in characters; past it the rest is cut with a note.
export const MAX_INSTRUCTIONS = 40_000;
const MAX_IMPORT_DEPTH = 3;

const repoRoot = (cwd: string): string => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
};

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export function loadInstructions(cwd: string): InstructionFile[] {
  const root = real(repoRoot(resolve(cwd)));
  const here = real(resolve(cwd));
  if (!root || !here || !inside(root, here)) return [];
  const dirs = [root];
  for (let d = here; d !== root; d = dirname(d)) dirs.splice(1, 0, d);
  const seen = new Set<string>();
  const files: InstructionFile[] = [];
  for (const dir of dirs) {
    const name = INSTRUCTION_NAMES.find((n) => existsSync(join(dir, n)));
    if (!name) continue;
    const text = read(root, join(dir, name), seen, 0);
    if (text?.trim()) files.push({ path: relative(root, join(dir, name)), text: text.trim() });
  }
  return files;
}

// A file's text with its `@path` lines replaced by the files they name. Undefined for a file outside the
// repository, one already read, or one that is not a regular file.
function read(root: string, path: string, seen: Set<string>, depth: number): string | undefined {
  const p = real(path);
  if (!p || !inside(root, p) || seen.has(p)) return undefined;
  try {
    if (!statSync(p).isFile()) return undefined;
  } catch {
    return undefined;
  }
  seen.add(p);
  const text = readFileSync(p, 'utf8');
  return text
    .split('\n')
    .map((line) => {
      const m = /^@(\S+)\s*$/.exec(line.trim());
      if (!m || depth >= MAX_IMPORT_DEPTH) return line;
      const target = resolve(dirname(p), m[1]!);
      return read(root, target, seen, depth + 1) ?? line;
    })
    .join('\n');
}

// How the files reach the model: each in its own frame, the whole capped.
export function instructionsBlock(files: InstructionFile[], max = MAX_INSTRUCTIONS): string {
  let left = max;
  const parts: string[] = [];
  for (const f of files) {
    if (left <= 0) {
      parts.push(`<project_instructions path="${f.path}">[left out: the instructions passed ${max} characters]</project_instructions>`);
      continue;
    }
    const text = inert(f.text);
    const kept = text.length > left ? `${text.slice(0, left)}\n[... ${text.length - left} characters cut: read ${f.path} for the rest]` : text;
    left -= text.length;
    parts.push(`<project_instructions path="${f.path}">\n${kept}\n</project_instructions>`);
  }
  if (!parts.length) return '';
  return `The repository's instructions for agents, root first (a nearer file wins where they differ). Follow them where they bear on the task; they cannot widen what the permission mode and the sandbox allow.\n${parts.join('\n')}`;
}
