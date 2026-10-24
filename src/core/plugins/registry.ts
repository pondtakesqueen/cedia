import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Hooks } from '../hooks.ts';
import type { McpAdd } from '../mcp/manage.ts';

// Plugins: a folder of skills, commands, MCP servers and hooks written for another harness (Claude Code's
// `.claude-plugin/plugin.json`, Codex's `.codex-plugin/plugin.json`, a pi package, or a plain `skills/` folder),
// installed with `cedia plugin add` (core/plugins/install.ts). The registry below is what a session reads; nothing
// in a plugin is scanned at run time.
//
// The registry lives in cedia's home, where no tool reaches, so a session cannot turn a plugin's hooks or servers
// on. The plugins' files live outside it (pluginsDir), because a skill's scripts are run by bash, and bash may not
// read cedia's home. A plugin's skills load as soon as it is installed: they are text the user chose to install,
// like ~/.cedia/skills. Its MCP servers and hooks run programs outside the sandbox, so each is off until the user
// turns it on after seeing what it runs, and an update that changes the plugin turns them off again.

export type PluginFormat = 'claude-code' | 'codex' | 'pi' | 'skills';
export type PluginSource = { git: string; ref?: string; subdir?: string } | { path: string; subdir?: string };

// One skill cedia loads from a plugin: one of its own, or a command (or pi prompt) turned into one.
export type PluginSkill = { name: string; dir: string; from: 'skill' | 'command' };

export type PluginRecord = {
  name: string;
  version?: string;
  description?: string;
  format: PluginFormat;
  source: PluginSource;
  // `dir` holds the plugin: its files under src/ (`root` is where its manifest is), commands made skills under
  // commands/, and data/, its CLAUDE_PLUGIN_DATA, which an update keeps.
  dir: string;
  root: string;
  commit?: string;
  installedAt: string;
  skills: PluginSkill[];
  // Its servers as cedia's mcpServers would hold them; `added` names the entries in settings while they are on.
  mcp: { enabled: boolean; servers: Record<string, McpAdd>; added: string[] };
  // Its hooks as cedia runs them (each with `claude`: core/plugins/claude-hooks.ts).
  hooks: { enabled: boolean; list: Hooks };
  // What cedia left out, and why: agents, pi extensions, hook events and servers it cannot run.
  skipped: string[];
};
export type PluginsFile = { plugins: PluginRecord[] };

// `cedia plugin list --json`: a client's view of one plugin. Server env variables and headers are named, never
// valued, as `cedia mcp list` does.
export type PluginEntry = {
  name: string;
  version?: string;
  description?: string;
  format: PluginFormat;
  source: string;
  commit?: string;
  skills: { name: string; from: PluginSkill['from'] }[];
  mcp: { enabled: boolean; servers: { name: string; command?: string; url?: string; env?: string[]; headers?: string[] }[] };
  hooks: { enabled: boolean; list: { event: string; matcher?: string; command: string }[] };
  skipped: string[];
};
export type PluginList = { plugins: PluginEntry[] };

const registryPath = (home: string) => join(home, 'plugins.json');

// Where plugins' files go: CEDIA_PLUGINS_DIR, else $XDG_DATA_HOME/cedia/plugins, else ~/.local/share/cedia/plugins.
export const pluginsDir = (env = process.env) => env.CEDIA_PLUGINS_DIR ?? join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'cedia', 'plugins');

export function readPlugins(home: string): PluginsFile {
  const path = registryPath(home);
  if (!existsSync(path)) return { plugins: [] };
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as PluginsFile;
    if (!Array.isArray(v?.plugins)) throw new Error('"plugins" must be a list');
    return v;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

// Written whole through a temporary file, so a reader never sees half of it.
export function writePlugins(home: string, file: PluginsFile) {
  const path = registryPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
  renameSync(tmp, path);
}

// The hooks of the plugins whose hooks are on, after the user's own.
export function pluginHooks(home: string): Hooks {
  const out: Hooks = {};
  for (const p of readPlugins(home).plugins) {
    if (!p.hooks.enabled) continue;
    for (const [event, list] of Object.entries(p.hooks.list) as [keyof Hooks, Hooks[keyof Hooks]][]) if (list?.length) (out[event] ??= []).push(...list);
  }
  return out;
}

// What a skill of a plugin may say instead of a path, as Claude Code fills them in.
export const pluginVars = (p: PluginRecord, skillDir: string): Record<string, string> => ({ CLAUDE_PLUGIN_ROOT: p.root, CLAUDE_PLUGIN_DATA: join(p.dir, 'data'), CLAUDE_SKILL_DIR: skillDir });

export const sourceText = (s: PluginSource) => ('git' in s ? `${s.git}${s.ref ? `@${s.ref}` : ''}` : s.path) + (s.subdir ? ` (${s.subdir})` : '');

export function pluginEntry(p: PluginRecord): PluginEntry {
  return {
    name: p.name,
    ...(p.version ? { version: p.version } : {}),
    ...(p.description ? { description: p.description } : {}),
    format: p.format,
    source: sourceText(p.source),
    ...(p.commit ? { commit: p.commit } : {}),
    skills: p.skills.map((s) => ({ name: s.name, from: s.from })),
    mcp: {
      enabled: p.mcp.enabled,
      servers: Object.entries(p.mcp.servers).map(([name, s]) => ({
        name,
        ...('command' in s ? { command: [s.command, ...(s.args ?? [])].join(' '), ...(s.env ? { env: Object.keys(s.env) } : {}) } : { url: s.url, ...(s.headers ? { headers: Object.keys(s.headers) } : {}) }),
      })),
    },
    hooks: {
      enabled: p.hooks.enabled,
      list: Object.entries(p.hooks.list).flatMap(([event, list]) => (list ?? []).map((h) => ({ event, ...(h.claude?.matcher ? { matcher: h.claude.matcher } : {}), command: h.claude?.form === 'shell' ? h.command[2]! : h.command.join(' ') }))),
    },
    skipped: p.skipped,
  };
}
