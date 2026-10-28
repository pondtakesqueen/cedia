import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { cediaHome } from '../config.ts';
import { addMcp, removeMcp, type McpAdd } from '../mcp/manage.ts';
import { inside, real } from '../project/instructions.ts';

// Plugins in the Claude Code layout, so the plugins people already publish work as they are: a folder with
// `.claude-plugin/plugin.json` (or `plugin.json`), `skills/<name>/SKILL.md`, `commands/<name>.md`, `agents/`,
// `hooks/hooks.json` and `.mcp.json`. Installing copies the folder into ~/.cedia/plugins/<name>; a repository never
// adds one (discovery reads home only).
//
// What a session gets from an enabled plugin is text: its skills and its commands join the skill list (as
// `<plugin>:<name>`, core/skills/skills.ts), redacted and made inert like a repository's. Nothing a plugin ships
// runs on its own. Its MCP servers start only once the user adds them with `cedia plugin mcp <name>`, which puts
// them in mcpServers where every other server lives; its hooks and agents are listed and never run, since a
// Claude Code hook is a shell line outside the sandbox written for Claude Code's tools.

export type PluginManifest = {
  name: string;
  version: string;
  description?: string;
  // Where the folder is: the source while installing, the copy in ~/.cedia/plugins after.
  dir: string;
};

// What a plugin folder holds, for `cedia plugin show`.
export type PluginContents = {
  skills: string[];
  commands: string[];
  agents: string[];
  hooks: boolean;
  mcpServers: string[];
};

export type InstalledPlugin = {
  name: string;
  version: string;
  installPath: string;
  installedAt: string;
  lastUpdated: string;
  enabled: boolean;
  // What `update` installs from again: a folder, a git URL, or `<plugin>@<marketplace>`.
  source?: string;
  // The mcpServers entries `cedia plugin mcp` added, removed again with the plugin.
  mcp?: string[];
};

export type InstalledPluginsFile = { version: number; plugins: Record<string, InstalledPlugin> };

export const pluginsDir = (home = cediaHome()) => join(home, 'plugins');
export const marketplacesPath = (home = cediaHome()) => join(home, 'known_marketplaces.json');
export const installedPluginsPath = (home = cediaHome()) => join(home, 'installed_plugins.json');

function readJson(path: string): any {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

// A plugin's name becomes a directory under ~/.cedia/plugins that install replaces and uninstall deletes, so it is
// one path segment: "../.." in a downloaded plugin.json would have install delete a directory outside it.
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MANIFESTS = [join('.claude-plugin', 'plugin.json'), 'plugin.json'];

export function loadManifest(dir: string): PluginManifest | null {
  for (const rel of MANIFESTS) {
    const m = readJson(join(dir, rel)) as Partial<PluginManifest> | null;
    if (!m) continue;
    if (typeof m.name !== 'string' || !PLUGIN_NAME.test(m.name)) return null;
    return { name: m.name, version: typeof m.version === 'string' ? m.version : '0.0.0', ...(typeof m.description === 'string' ? { description: m.description } : {}), dir };
  }
  return null;
}

const entries = (dir: string, keep: (name: string, isDir: boolean) => boolean): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => keep(e.name, e.isDirectory()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

// The MCP servers a plugin names, in its manifest or its .mcp.json, with ${CLAUDE_PLUGIN_ROOT} (Claude Code's name
// for the plugin's folder) and ${CEDIA_PLUGIN_ROOT} made the installed folder.
export function pluginMcpServers(dir: string): Record<string, unknown> {
  const fromManifest = (readJson(join(dir, MANIFESTS[0]!)) ?? readJson(join(dir, MANIFESTS[1]!)))?.mcpServers;
  const file = typeof fromManifest === 'string' ? readJson(resolve(dir, fromManifest)) : readJson(join(dir, '.mcp.json'));
  const raw = fromManifest && typeof fromManifest === 'object' ? fromManifest : (file?.mcpServers ?? file ?? {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const root = (s: string) => s.replace(/\$\{(?:CLAUDE|CEDIA)_PLUGIN_ROOT\}/g, dir);
  const swap = (v: unknown): unknown => (typeof v === 'string' ? root(v) : Array.isArray(v) ? v.map(swap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
  return swap(raw) as Record<string, unknown>;
}

export function pluginContents(dir: string): PluginContents {
  return {
    skills: entries(join(dir, 'skills'), (n, d) => d && existsSync(join(dir, 'skills', n, 'SKILL.md'))),
    commands: entries(join(dir, 'commands'), (n, d) => !d && n.endsWith('.md')).map((n) => n.slice(0, -3)),
    agents: entries(join(dir, 'agents'), (n, d) => !d && n.endsWith('.md')).map((n) => n.slice(0, -3)),
    hooks: existsSync(join(dir, 'hooks', 'hooks.json')),
    mcpServers: Object.keys(pluginMcpServers(dir)).sort(),
  };
}

export function loadInstalled(home = cediaHome()): InstalledPluginsFile {
  const raw = readJson(installedPluginsPath(home));
  if (raw && typeof raw === 'object' && raw.plugins && typeof raw.plugins === 'object') {
    return { version: raw.version ?? 2, plugins: raw.plugins };
  }
  return { version: 2, plugins: {} };
}
function saveInstalled(home: string, data: InstalledPluginsFile) {
  writeJson(installedPluginsPath(home), data);
}

export function listInstalled(home = cediaHome()): InstalledPlugin[] {
  return Object.values(loadInstalled(home).plugins);
}

// The plugins a session takes skills from: installed, enabled, and still in ~/.cedia/plugins. Home only: a
// repository must not add what a session reads the way the user's own plugins add it.
export function enabledPlugins(home = cediaHome()): InstalledPlugin[] {
  const root = real(pluginsDir(home));
  return listInstalled(home)
    .filter((p) => p.enabled && PLUGIN_NAME.test(p.name))
    .filter((p) => {
      const at = real(p.installPath);
      return !!root && !!at && inside(root, at) && at !== root;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// A git source: an https or ssh URL, or github:<owner>/<repo>. Anything else is a folder.
const GIT = /^(?:https:\/\/|git@)[^\s]+$/;
function gitUrl(source: string): string | undefined {
  const gh = /^github:([\w.-]+\/[\w.-]+)$/.exec(source);
  if (gh) return `https://github.com/${gh[1]}.git`;
  return GIT.test(source) ? source : undefined;
}

// A shallow clone into a fresh folder under ~/.cedia/plugins/.tmp. `--` keeps the URL from being read as an option.
function clone(url: string, home: string): string {
  const base = join(pluginsDir(home), '.tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'src-'));
  const r = Bun.spawnSync(['git', 'clone', '--quiet', '--depth', '1', '--', url, dir], { stdout: 'ignore', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git clone ${url} failed: ${r.stderr.toString().trim().slice(0, 300)}`);
  }
  return dir;
}

// A marketplace's plugin, as `<plugin>@<marketplace>`: the marketplace's .claude-plugin/marketplace.json names
// each plugin's source, a folder inside the marketplace or a git repository.
function fromMarketplace(spec: string, home: string, temps: string[]): string {
  const [plugin, market] = spec.split('@') as [string, string];
  const source = loadMarketplaces(home).find((m) => m.name === market)?.source;
  if (!source) throw new Error(`no marketplace ${market}; add it with cedia marketplace add ${market} <source>`);
  const url = gitUrl(source);
  const root = url ? clone(url, home) : resolve(source);
  if (url) temps.push(root);
  const list = readJson(join(root, '.claude-plugin', 'marketplace.json'));
  const entry = Array.isArray(list?.plugins) ? list.plugins.find((p: { name?: unknown }) => p?.name === plugin) : undefined;
  if (!entry) throw new Error(`marketplace ${market} has no plugin ${plugin}`);
  const src = entry.source;
  if (typeof src === 'string') {
    const dir = real(resolve(root, src));
    const top = real(root);
    if (!dir || !top || !inside(top, dir)) throw new Error(`plugin ${plugin}'s source ${src} is outside marketplace ${market}`);
    return dir;
  }
  const repo = src?.source === 'github' && typeof src.repo === 'string' ? `github:${src.repo}` : src?.source === 'url' && typeof src.url === 'string' ? src.url : undefined;
  const git = repo && gitUrl(repo);
  if (!git) throw new Error(`plugin ${plugin} in marketplace ${market} has a source cedia cannot read`);
  const dir = clone(git, home);
  temps.push(dir);
  return dir;
}

export function installPlugin(source: string, home = cediaHome()): InstalledPlugin {
  const temps: string[] = [];
  try {
    const url = gitUrl(source);
    const market = !url && /^[^@/\\\s]+@[^@/\\\s]+$/.test(source) && !existsSync(source);
    const src = url ? clone(url, home) : market ? fromMarketplace(source, home, temps) : resolve(source);
    if (url) temps.push(src);
    const manifest = loadManifest(src);
    if (!manifest) throw new Error(`no plugin.json (or .claude-plugin/plugin.json) with a name in ${src}`);
    const dest = join(pluginsDir(home), manifest.name);
    mkdirSync(pluginsDir(home), { recursive: true });
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, filter: (p) => basename(p) !== '.git' });
    const now = new Date().toISOString();
    const data = loadInstalled(home);
    const before = data.plugins[manifest.name];
    const rec: InstalledPlugin = {
      name: manifest.name,
      version: manifest.version,
      installPath: dest,
      installedAt: before?.installedAt ?? now,
      lastUpdated: now,
      enabled: before?.enabled ?? true,
      source: url || market ? source : src,
      ...(before?.mcp?.length ? { mcp: before.mcp } : {}),
    };
    data.plugins[manifest.name] = rec;
    saveInstalled(home, data);
    return rec;
  } finally {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  }
}

export function uninstallPlugin(name: string, home = cediaHome()): void {
  const data = loadInstalled(home);
  const rec = data.plugins[name];
  if (!rec) throw new Error(`no plugin ${name}`);
  for (const server of rec.mcp ?? []) {
    try { removeMcp(server); } catch { /* already gone */ }
  }
  const root = real(pluginsDir(home));
  const at = real(rec.installPath);
  if (root && at && inside(root, at) && at !== root) rmSync(at, { recursive: true, force: true });
  delete data.plugins[name];
  saveInstalled(home, data);
}

export function setPluginEnabled(name: string, enabled: boolean, home = cediaHome()): void {
  const data = loadInstalled(home);
  if (!data.plugins[name]) throw new Error(`no plugin ${name}`);
  data.plugins[name]!.enabled = enabled;
  data.plugins[name]!.lastUpdated = new Date().toISOString();
  saveInstalled(home, data);
}

// Installs again from where it came from: the folder, the git repository or the marketplace.
export function updatePlugin(name: string, home = cediaHome()): InstalledPlugin {
  const rec = loadInstalled(home).plugins[name];
  if (!rec) throw new Error(`no plugin ${name}`);
  if (!rec.source) throw new Error(`plugin ${name} does not say where it was installed from; install it again`);
  return installPlugin(rec.source, home);
}

// `cedia plugin mcp <name>`: the user's go-ahead for a plugin's MCP servers. Each goes into mcpServers as
// `<plugin>-<server>`, checked as `cedia mcp add` checks it, and leaves with the plugin.
export function addPluginMcp(name: string, home = cediaHome()): { added: string[]; refused: { server: string; error: string }[] } {
  const data = loadInstalled(home);
  const rec = data.plugins[name];
  if (!rec) throw new Error(`no plugin ${name}`);
  const added: string[] = [];
  const refused: { server: string; error: string }[] = [];
  for (const [server, cfg] of Object.entries(pluginMcpServers(rec.installPath))) {
    const id = `${name}-${server}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
    // Claude Code's entries may say `type`; cedia knows a server by its command or URL.
    const { type: _type, ...rest } = (cfg && typeof cfg === 'object' ? cfg : {}) as Record<string, unknown>;
    try {
      addMcp(id, rest as McpAdd);
      added.push(id);
    } catch (e) {
      refused.push({ server, error: (e as Error).message });
    }
  }
  rec.mcp = [...new Set([...(rec.mcp ?? []), ...added])];
  saveInstalled(home, data);
  return { added, refused };
}

// Marketplace registry (name -> source: a folder or a git URL holding .claude-plugin/marketplace.json).
export type Marketplace = { name: string; source: string };
export function loadMarketplaces(home = cediaHome()): Marketplace[] {
  const raw = readJson(marketplacesPath(home));
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([name, source]) => ({ name, source: String(source) }));
}
export function addMarketplace(name: string, source: string, home = cediaHome()): void {
  const raw = (readJson(marketplacesPath(home)) as Record<string, string> | null) ?? {};
  raw[name] = source;
  writeJson(marketplacesPath(home), raw);
}
export function removeMarketplace(name: string, home = cediaHome()): void {
  const raw = (readJson(marketplacesPath(home)) as Record<string, string> | null) ?? {};
  delete raw[name];
  writeJson(marketplacesPath(home), raw);
}

// For tests and `cedia plugin list`: the manifest of each installed plugin folder.
export function discoverPlugins(home = cediaHome()): PluginManifest[] {
  return enabledPlugins(home).flatMap((p) => {
    const m = loadManifest(p.installPath);
    return m ? [m] : [];
  });
}
