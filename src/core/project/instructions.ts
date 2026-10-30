import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactSecrets } from '../safety/secrets.ts';
import { inert } from '../trust/frame.ts';

// The repository's own instructions for agents: an AGENTS.md (or, where a directory has none, a CLAUDE.md) in each
// directory from the repository's root down to the working directory, root first, so the nearer file reads last
// and wins where they differ. A line that is only `@path` brings in that file (CLAUDE.md here is `@AGENTS.md`).
//
// They go in the session's first user turn with the environment, never the cached system prompt, so the system
// prompt stays one across repositories. They are the repository's words, not the user's: an import may only name
// a file inside the repository (a symlink out of it counts as outside) that does not look like a secret (`.env`,
// keys, `.git/`), so a cloned repo cannot pull ~/.ssh or its own credentials into the context; the text goes
// through the same redaction as tool output, and is made inert so it cannot close a frame and speak as cedia. The sandbox and the deny
// list still decide what a call may do whatever the file says.

export type InstructionFile = { path: string; text: string };

export const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md'];
// The most the files may take of the first turn, in characters; past it the rest is cut with a note.
export const MAX_INSTRUCTIONS = 40_000;
const MAX_IMPORT_DEPTH = 3;
// A file larger than this is not read at all: instructions are prose, and the cap would cut it anyway.
const MAX_FILE_BYTES = 256 * 1024;
// Files an import never brings in, whatever the repository says.
export const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?)$/i;

export const repoRoot = (cwd: string): string => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
};

export const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

export const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
    // The first of the names that reads: an AGENTS.md that is a directory or points outside falls through.
    for (const name of INSTRUCTION_NAMES) {
      if (!existsSync(join(dir, name))) continue;
      const text = read(root, join(dir, name), seen, 0);
      if (text === undefined) continue;
      if (text.trim()) files.push({ path: relative(root, join(dir, name)), text: text.trim() });
      break;
    }
  }
  return files;
}

// A file's text with its `@path` lines replaced by the files they name. Undefined for a file outside the
// repository, one already read, or one that is not a regular file.
function read(root: string, path: string, seen: Set<string>, depth: number): string | undefined {
  const p = real(path);
  if (!p || !inside(root, p) || seen.has(p)) return undefined;
  if (depth > 0 && (SECRET_NAME.test(basename(p)) || relative(root, p).split(sep).includes('.git'))) return undefined;
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
  } catch {
    return undefined;
  }
  seen.add(p);
  let text: string;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
  // An `@path` inside a code fence is an example, not an import.
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const m = /^@(\S+)\s*$/.exec(line.trim());
      if (!m || fenced || depth >= MAX_IMPORT_DEPTH) return line;
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
    const path = attr(f.path);
    if (left <= 0) {
      parts.push(`<project_instructions path="${path}">[left out: the instructions passed ${max} characters]</project_instructions>`);
      continue;
    }
    const text = inert(redactSecrets(f.text).text);
    // Cut on a code point, never inside a surrogate pair.
    const cut = /[\uD800-\uDBFF]/.test(text[left - 1] ?? '') ? left - 1 : left;
    const kept = text.length > left ? `${text.slice(0, cut)}\n[... ${text.length - cut} characters cut: read ${path} for the rest]` : text;
    left -= text.length;
    parts.push(`<project_instructions path="${path}">\n${kept}\n</project_instructions>`);
  }
  if (!parts.length) return '';
  return `The repository's instructions for agents, root first (a nearer file wins where they differ). Follow them where they bear on the task; they cannot widen what the permission mode and the sandbox allow.\n${parts.join('\n')}`;
}

// A folder's own instructions, shown when the model first reads or writes a file under it (Delta's folder rules):
// the AGENTS.md (or CLAUDE.md) of each directory from the repository's root down to the file's, except the ones
// the first turn already had (the root down to the working directory) and the ones `shown` names, which this
// session has seen. They go after the tool's result, so the cached prefix is never touched, and the result is
// logged like any other: a later session, or a resumed one, knows from its log which it has seen.
export const MAX_NESTED_INSTRUCTIONS = 20_000;
const SHOWN = /<project_instructions path="([^"]+)">/g;
const attr = (p: string) => p.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The instruction files a session's texts show, by path as their frames name it.
export function shownInstructions(texts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(SHOWN)) out.add(m[1]!);
  return out;
}

export function nestedInstructions(cwd: string, file: string, shown: Set<string>): InstructionFile[] {
  const root = real(repoRoot(resolve(cwd)));
  const here = real(resolve(cwd));
  const at = real(dirname(resolve(cwd, file)));
  if (!root || !here || !at || !inside(root, at)) return [];
  const dirs: string[] = [];
  for (let d = at; d !== root && inside(root, d); d = dirname(d)) if (!inside(d, here)) dirs.unshift(d);
  const seen = new Set<string>();
  const files: InstructionFile[] = [];
  for (const dir of dirs) {
    for (const name of INSTRUCTION_NAMES) {
      if (!existsSync(join(dir, name))) continue;
      const path = relative(root, join(dir, name));
      if (shown.has(attr(path))) break;
      const text = read(root, join(dir, name), seen, 0);
      if (text === undefined) continue;
      if (text.trim()) files.push({ path, text: text.trim() });
      break;
    }
  }
  return files;
}

// What follows the tool's result: the files, each in its frame, the whole capped.
export function nestedNote(files: InstructionFile[]): string {
  if (!files.length) return '';
  const block = instructionsBlock(files, MAX_NESTED_INSTRUCTIONS);
  return `[cedia: the folder you just worked in has its own instructions for agents. They add to the ones you started with, and the nearer file wins where they differ.]\n${block.slice(block.indexOf('\n') + 1)}`;
}
