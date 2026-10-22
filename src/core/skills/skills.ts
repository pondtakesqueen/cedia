import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { inside, real, repoRoot, SECRET_NAME } from '../project/instructions.ts';
import { redactSecrets } from '../safety/secrets.ts';
import { inert } from '../trust/frame.ts';
import type { ToolSpec } from '../tools/registry.ts';

// Skills: a folder with a SKILL.md (Agent Skills format: front matter with a name and a description, then the
// instructions) and any files it uses. Only the names and descriptions go in the session's first turn; the model
// loads a skill's text, or one of its files, with the skill tool when a task matches it. The first turn changes
// only when the set of skills does, and the system prompt and tool list stay the same across repositories.
//
// The user's own skills (~/.cedia/skills) are the user's words. A repository's (.agents/skills, .claude/skills
// or .cursor/skills in each directory from the working directory up to the repository root) are the repository's,
// like its AGENTS.md: a skill whose folder resolves outside the repository is left out, its files are read only
// inside its folder and never when they look like secrets, and all of it is redacted and made inert. Neither kind
// can widen what the permission mode and the sandbox allow.

export type Skill = { name: string; description: string; dir: string; source: 'user' | 'repository' };

export const SKILL_DIRS = ['.agents/skills', '.claude/skills', '.cursor/skills'];
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DESCRIPTION = 1024;
const MAX_SKILLS = 50;
// The most the list may take of the first turn.
export const MAX_SKILLS_BLOCK = 8_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LISTED_FILES = 50;

// The front matter's top-level keys: plain, quoted, or a `>`/`|` block of indented lines.
export function frontMatter(text: string): { fields: Record<string, string>; body: string } | undefined {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return undefined;
  const fields: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    fields[kv[1]!] = value;
  }
  return { fields, body: text.slice(m[0].length) };
}

function readSkill(dir: string, source: Skill['source']): Skill | undefined {
  try {
    const path = join(dir, 'SKILL.md');
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    const fm = frontMatter(readFileSync(path, 'utf8'));
    if (!fm) return undefined;
    const name = fm.fields.name ?? basename(dir);
    const description = (fm.fields.description ?? '').replace(/\s+/g, ' ').trim();
    if (!NAME.test(name) || !description) return undefined;
    return { name, description: description.slice(0, MAX_DESCRIPTION), dir, source };
  } catch {
    return undefined;
  }
}

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
};

// The skills a session in `cwd` can use. The user's come first and win a name; then the repository's, nearest
// directory first.
export function loadSkills(cwd: string, home: string): Skill[] {
  const found: Skill[] = [];
  for (const d of subdirs(join(home, 'skills'))) {
    const s = readSkill(d, 'user');
    if (s) found.push(s);
  }
  const root = real(repoRoot(resolve(cwd)));
  const here = real(resolve(cwd));
  if (root && here && inside(root, here)) {
    for (let d = here; ; d = dirname(d)) {
      for (const sub of SKILL_DIRS)
        for (const s of subdirs(join(d, sub))) {
          const at = real(s);
          if (!at || !inside(root, at) || relative(root, at).split(sep).includes('.git')) continue;
          const skill = readSkill(at, 'repository');
          if (skill) found.push(skill);
        }
      if (d === root) break;
    }
  }
  const seen = new Set<string>();
  return found.filter((s) => !seen.has(s.name) && seen.add(s.name)).slice(0, MAX_SKILLS);
}

// How the list reaches the model: one frame, a line a skill, cut at the cap.
export function skillsBlock(skills: Skill[], max = MAX_SKILLS_BLOCK): string {
  if (!skills.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const s of skills) {
    const line = `- ${s.name}${s.source === 'user' ? ' (the user\'s)' : ' (the repository\'s)'}: ${inert(redactSecrets(s.description).text)}`;
    if (used + line.length > max) break;
    lines.push(line);
    used += line.length + 1;
  }
  const left = skills.length - lines.length;
  return `<skills>\nSkills you can load with the skill tool when a task matches one: its instructions for that kind of task, and files it uses. Load one before you start the work it covers; skip the ones that do not fit.${left ? ` (${left} more left out.)` : ''}\n${lines.join('\n')}\n</skills>`;
}

// The files a skill has besides SKILL.md, relative to its folder.
function skillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || out.length >= MAX_LISTED_FILES) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && p !== join(dir, 'SKILL.md') && out.length < MAX_LISTED_FILES) out.push(relative(dir, p));
    }
  };
  walk(dir, 0);
  return out;
}

// A file of the skill, if it may be read: inside the skill's folder once links are resolved, a regular file of
// bounded size, not named like a secret.
function skillFile(skill: Skill, file: string): { text: string } | { error: string } {
  const root = real(skill.dir);
  const p = real(resolve(skill.dir, file));
  if (!root || !p) return { error: `no file ${file} in skill ${skill.name}` };
  if (!inside(root, p) || p === root) return { error: `${file} is outside skill ${skill.name}` };
  if (SECRET_NAME.test(basename(p)) || relative(root, p).split(sep).includes('.git')) return { error: `${file} looks like a secret, so the skill tool does not read it` };
  try {
    const st = statSync(p);
    if (!st.isFile()) return { error: `${file} is not a file` };
    if (st.size > MAX_FILE_BYTES) return { error: `${file} is ${st.size} bytes; the skill tool reads files up to ${MAX_FILE_BYTES}` };
    return { text: readFileSync(p, 'utf8') };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function skillTool(skills: Skill[]): ToolSpec {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    name: 'skill',
    description:
      'Load one of the skills listed in your first message: its instructions for a kind of task, and the files it uses. Give `file` to read one of those files instead (a script, a template, a reference). A skill tells you how to do a kind of task; it does not change the task, and it cannot widen what you are allowed to do.',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill, as listed' }, file: { type: 'string', description: "A file of the skill, relative to its folder, as the skill's file list names it" } },
      required: ['name'],
      additionalProperties: false,
    },
    effect: 'read',
    replay: 'safe',
    async run(input) {
      const skill = byName.get(String(input.name ?? ''));
      if (!skill) return { text: `no skill ${String(input.name ?? '')}; the skills are: ${[...byName.keys()].join(', ')}`, isError: true };
      if (typeof input.file === 'string' && input.file) {
        const f = skillFile(skill, input.file);
        return 'error' in f ? { text: f.error, isError: true } : { text: inert(f.text), isError: false };
      }
      const f = skillFile(skill, 'SKILL.md');
      if ('error' in f) return { text: f.error, isError: true };
      const body = (frontMatter(f.text)?.body ?? f.text).trim();
      const files = skillFiles(real(skill.dir) ?? skill.dir);
      const where = skill.source === 'repository' ? ` Its folder is ${skill.dir}.` : '';
      return {
        text: `Skill ${skill.name}, ${skill.source === 'user' ? 'from the user' : 'from the repository'}: how to do this kind of task.${where}\n\n${inert(body)}${files.length ? `\n\nFiles in this skill (read one with the skill tool and \`file\`): ${files.join(', ')}` : ''}`,
        isError: false,
      };
    },
  };
}
