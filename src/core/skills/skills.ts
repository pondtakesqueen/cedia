import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { inside, real, repoRoot, SECRET_NAME } from '../project/instructions.ts';
import { enabledPlugins } from '../plugins/plugins.ts';
import { redactSecrets } from '../safety/secrets.ts';
import { inert } from '../trust/frame.ts';
import type { ToolSpec } from '../tools/registry.ts';
import type { SessionEvent } from '../types.ts';

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
//
// An enabled plugin's skills (skills/<name>/SKILL.md) and commands (commands/<name>.md, a Claude Code slash command:
// front matter, then the prompt) are listed as `<plugin>:<name>`, after the repository's. They are a third party's
// text, so they are treated as a repository's are: read only inside the plugin's folder, redacted and made inert.
//
// A skill whose front matter says `disable-model-invocation: true` (Claude Code's key; pstack sets it on nearly every
// skill) is the person's to pick: it is a `/` command but stays out of the first turn's list, so a plugin with dozens
// of them costs the session nothing until one is asked for. The skill tool still loads it by name, for the `/` line
// and for a loaded skill that names it.

export type Skill = {
  name: string;
  description: string;
  dir: string;
  source: 'user' | 'repository' | 'plugin';
  argumentHint?: string;
  // The plugin a `plugin` skill came from.
  plugin?: string;
  // A command's own file in `dir`, which holds its instructions in place of SKILL.md; a command has no other files.
  file?: string;
  // Only the person picks it, with `/`: `disable-model-invocation: true`. Left out of the first turn's list.
  manual?: true;
};

// `cedia commands --json`: what a client offers when the person types `/`. Each skill is a command; `/<name> <text>`
// sent as a prompt asks the writer to load that skill first (skillCommand).
export type CommandEntry = { name: string; description: string; kind: 'skill'; source: Skill['source']; argumentHint?: string };
export type CommandList = { commands: CommandEntry[] };

export const SKILL_DIRS = ['.agents/skills', '.claude/skills', '.cursor/skills'];
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// A command is named by its file, as in Claude Code (`clean_gone.md`).
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_DESCRIPTION = 1024;
const MAX_SKILLS = 50;
// The `/`-only skills are counted apart: they cost the first turn nothing, and a plugin like pstack ships 57.
const MAX_MANUAL = 200;
// The most the list may take of the first turn.
export const MAX_SKILLS_BLOCK = 8_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LISTED_FILES = 50;

// The front matter's top-level keys: plain, quoted, or a `>`/`|` block of indented lines.
export function frontMatter(text: string): { fields: Record<string, string>; body: string } | undefined {
  const m = /^\uFEFF?---\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return undefined;
  const fields: Record<string, string> = {};
  const lines = (m[1] ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else if (/^"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/.test(value)) {
      value = value.replace(/^"((?:[^"\\]|\\.)*)"[\s\S]*$/, '$1').replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
    } else if (/^'(?:[^']|'')*'\s*(?:#.*)?$/.test(value)) {
      value = value.replace(/^'((?:[^']|'')*)'[\s\S]*$/, '$1').replace(/''/g, "'");
    } else {
      // A plain value: a comment after it is not part of it, and indented lines after it continue it.
      value = value.replace(/(^|\s+)#.*$/, '');
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) value += ` ${lines[++i]!.trim()}`;
    }
    fields[kv[1]!] = value;
  }
  return { fields, body: text.slice(m[0].length) };
}

function readSkill(dir: string, source: Skill['source'], plugin?: { name: string; command?: string }): Skill | undefined {
  try {
    // SKILL.md (or the command's file) must be in the folder too: a link to a file elsewhere would put that file's
    // text in the turn.
    const file = plugin?.command ? `${plugin.command}.md` : 'SKILL.md';
    const path = real(join(dir, file));
    const folder = real(dir);
    if (!path || !folder || !inside(folder, path)) return undefined;
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    const text = readFileSync(path, 'utf8');
    // A command may have no front matter; then its first line describes it, as in Claude Code.
    const fm = frontMatter(text) ?? (plugin?.command ? { fields: {}, body: text } : undefined);
    if (!fm) return undefined;
    const own = plugin?.command ?? fm.fields.name ?? basename(dir);
    const first = plugin?.command ? (fm.body.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '') : '';
    // Redacted before it is cut, so a cut cannot split a secret past the redaction.
    const description = redactSecrets((fm.fields.description ?? first).replace(/\s+/g, ' ').trim()).text;
    if (!(plugin?.command ? COMMAND_NAME : NAME).test(own) || !description) return undefined;
    const hint = redactSecrets((fm.fields['argument-hint'] ?? '').replace(/\s+/g, ' ').trim()).text.slice(0, 200);
    return {
      name: plugin ? `${plugin.name}:${own}` : own,
      description: description.slice(0, MAX_DESCRIPTION),
      dir,
      source,
      ...(hint ? { argumentHint: hint } : {}),
      ...(plugin ? { plugin: plugin.name } : {}),
      ...(plugin?.command ? { file } : {}),
      ...(/^true$/i.test(fm.fields['disable-model-invocation'] ?? '') ? { manual: true as const } : {}),
    };
  } catch {
    return undefined;
  }
}

// An enabled plugin's skills, then its commands, each only from inside the plugin's folder.
function pluginSkills(home: string): Skill[] {
  const found: Skill[] = [];
  for (const p of enabledPlugins(home)) {
    const root = real(p.installPath);
    if (!root) continue;
    for (const d of subdirs(join(root, 'skills'))) {
      const at = real(d);
      const skill = at && inside(root, at) ? readSkill(at, 'plugin', { name: p.name }) : undefined;
      if (skill) found.push(skill);
    }
    const commands = real(join(root, 'commands'));
    if (!commands || !inside(root, commands)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(commands).filter((f) => f.endsWith('.md')).sort();
    } catch {
      files = [];
    }
    for (const f of files) {
      const skill = readSkill(commands, 'plugin', { name: p.name, command: f.slice(0, -3) });
      if (skill) found.push(skill);
    }
  }
  return found;
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
  found.push(...pluginSkills(home));
  const seen = new Set<string>();
  let listed = 0;
  let manual = 0;
  return found.filter((s) => !seen.has(s.name) && seen.add(s.name) && (s.manual ? ++manual <= MAX_MANUAL : ++listed <= MAX_SKILLS));
}

// How the list reaches the model: one frame, a line a skill, cut at the cap.
export function skillsBlock(all: Skill[], max = MAX_SKILLS_BLOCK): string {
  const skills = all.filter((s) => !s.manual);
  if (!skills.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const s of skills) {
    const line = `- ${s.name}${s.source === 'user' ? ' (the user\'s)' : s.source === 'plugin' ? ' (a plugin\'s)' : ' (the repository\'s)'}: ${inert(s.description)}`;
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
      else if (e.isFile() && p !== join(dir, 'SKILL.md') && !SECRET_NAME.test(e.name) && out.length < MAX_LISTED_FILES) out.push(relative(dir, p));
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

// A skill by name. A plugin's skill is listed as `<plugin>:<name>`, but its text calls itself and its siblings by the
// bare name (pstack's say `/statechart`), so a bare name that one plugin's skill alone ends with names that skill.
export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const exact = skills.find((s) => s.name === name);
  if (exact || name.includes(':')) return exact;
  const bare = skills.filter((s) => s.plugin && s.name === `${s.plugin}:${name}`);
  return bare.length === 1 ? bare[0] : undefined;
}

export function skillTool(skills: Skill[]): ToolSpec {
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
      const skill = findSkill(skills, String(input.name ?? ''));
      if (!skill) return { text: `no skill ${String(input.name ?? '')}; the skills are: ${skills.filter((s) => !s.manual).map((s) => s.name).join(', ')}`, isError: true };
      if (typeof input.file === 'string' && input.file && !skill.file) {
        const f = skillFile(skill, input.file);
        return 'error' in f ? { text: f.error, isError: true } : { text: inert(f.text), isError: false };
      }
      const f = skillFile(skill, skill.file ?? 'SKILL.md');
      if ('error' in f) return { text: f.error, isError: true };
      const body = (frontMatter(f.text)?.body ?? f.text).trim();
      const files = skill.file ? [] : skillFiles(real(skill.dir) ?? skill.dir);
      const where = skill.source !== 'user' && !skill.file ? ` Its folder is ${inert(skill.dir)}.` : '';
      const from = skill.source === 'user' ? 'from the user' : skill.source === 'plugin' ? `from the ${inert(skill.plugin ?? '')} plugin` : 'from the repository';
      // A Claude Code command stands for the text after it with $ARGUMENTS,
      // and runs each !`command` first, putting its output in the prompt; here the model runs them.
      const args =
        (skill.file && /\$ARGUMENTS|\$\d/.test(body) ? ' Where it says $ARGUMENTS (or $1, $2, ...), read the text the user wrote after the command.' : '') +
        (skill.file && /!`[^`]+`/.test(body) ? ' Where it shows !`command`, run that command with bash first and use its output there.' : '');
      return {
        text: `Skill ${skill.name}, ${from}: how to do this kind of task.${where}${args}\n\n${inert(body)}${files.length ? `\n\nFiles in this skill (read one with the skill tool and \`file\`): ${inert(files.join(', '))}` : ''}`,
        isError: false,
      };
    },
  };
}

export const commandList = (skills: Skill[]): CommandList => ({
  commands: skills.map((s) => ({ name: s.name, description: s.description, kind: 'skill', source: s.source, ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}) })),
});

// A prompt that starts with `/<skill>`: the person picked that skill from the command list. The prompt goes as
// typed, with a line asking the writer to load the skill first; any other prompt, `/` or not, is left alone.
export function skillCommand(prompt: string, skills: Skill[]): string | undefined {
  const m = /^\/((?:[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9_-]+)|[a-z0-9-]+)(?:\s|$)/.exec(prompt);
  const skill = m && findSkill(skills, m[1]!);
  if (!m || !skill) return undefined;
  const rest = prompt.slice(m[0].length).trim();
  return `${prompt.trimEnd()}\n\n(/${m[1]} is the ${skill.name} skill: load it with the skill tool first, then do what it says${rest ? ', for the text after the command' : ''}.)`;
}

// A session that goes on from another (a handoff note, a summary of its older turns, a fallback model) starts without
// the skills the other loaded: their instructions were tool results it no longer holds, and losing them fails
// silently (agentskills.io's client guide: "exempt skill content from pruning"). So the new session's first turn names
// them, and the model loads each again when it needs it. The names come from the skill calls that loaded a skill's
// instructions (not one of its files) and succeeded, and from the line an earlier carry put in the session's own
// first turn, so a chain of handoffs keeps them. That line can only come from cedia: a repository's text is made
// inert, which escapes its tags.
const CARRIED = /<skills_loaded>([^<]*)<\/skills_loaded>/;
const LOADED_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,128}$/;

export function loadedSkills(events: SessionEvent[]): string[] {
  const names: string[] = [];
  const add = (n: string) => {
    if (LOADED_NAME.test(n) && !names.includes(n)) names.push(n);
  };
  const ok = new Set(events.flatMap((e) => (e.kind === 'tool_result' && e.status === 'completed' && !e.output.isError ? [e.callId] : [])));
  for (const e of events) {
    if (e.kind === 'user' || e.kind === 'reminder') for (const n of CARRIED.exec(e.text)?.[1]?.split(',') ?? []) add(n.trim());
    else if (e.kind === 'tool_intent' && e.tool === 'skill' && !e.input.file && ok.has(e.callId) && typeof e.input.name === 'string') add(e.input.name);
  }
  return names;
}

// The skills to name in the next session: those loaded in what it does not keep word for word (`dropped`), less those
// loaded again in what it keeps (a summary's kept turns).
export function carriedSkills(dropped: SessionEvent[], kept: SessionEvent[] = []): string[] {
  const again = new Set(loadedSkills(kept));
  return loadedSkills(dropped).filter((n) => !again.has(n));
}

export const carriedSkillsNote = (names: string[]): string =>
  names.length
    ? `<skills_loaded>${names.join(', ')}</skills_loaded>\nThe earlier session had loaded these skills, and their instructions are not in this session. Load each again with the skill tool before the step it covers.`
    : '';
