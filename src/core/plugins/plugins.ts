import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { cediaHome } from '../config.ts';

export type PluginManifest = {
  name: string;
  version?: string;
  description?: string;
  commands?: string[];
  agents?: string[];
  outputStyles?: string[];
  hooks?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  lspServers?: Record<string, unknown>;
};

export type InstalledPlugin = {
  name: string;
  version: string;
  installPath: string;
  installedAt: string;
  lastUpdated: string;
  enabled: boolean;
};

export type InstalledPluginsFile = { version: number; plugins: Record<string, InstalledPlugin> };

export const pluginsDir = (home = cediaHome()) => join(home, 'plugins');
export const marketplacesPath = (home = cediaHome()) => join(home, 'known_marketplaces.json');
export const installedPluginsPath = (home = cediaHome()) => join(home, 'installed_plugins.json');
export const pluginDataDir = (name: string, home = cediaHome()) => join(home, 'plugins', 'data', name.replace(/[^A-Za-z0-9._-]/g, '-'));

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

export function loadManifest(dir: string): PluginManifest | null {
  const p = join(dir, 'plugin.json');
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as Partial<PluginManifest>;
    if (typeof m.name !== 'string' || !PLUGIN_NAME.test(m.name)) return null;
    return {
      name: m.name,
      version: m.version ?? '0.0.0',
      description: m.description,
      commands: m.commands ?? [],
      agents: m.agents ?? [],
      outputStyles: m.outputStyles ?? [],
      hooks: m.hooks ?? {},
      mcpServers: m.mcpServers ?? {},
      lspServers: m.lspServers ?? {},
    };
  } catch {
    return null;
  }
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

export function installPlugin(source: string, home = cediaHome()): InstalledPlugin {
  const src = resolve(source);
  const manifest = loadManifest(src);
  if (!manifest) throw new Error(`no plugin.json in ${src}`);
  const dest = join(pluginsDir(home), manifest.name);
  mkdirSync(pluginsDir(home), { recursive: true });
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  const now = new Date().toISOString();
  const rec: InstalledPlugin = {
    name: manifest.name,
    version: manifest.version ?? '0.0.0',
    installPath: dest,
    installedAt: now,
    lastUpdated: now,
    enabled: true,
  };
  const data = loadInstalled(home);
  data.plugins[manifest.name] = rec;
  saveInstalled(home, data);
  mkdirSync(pluginDataDir(manifest.name, home), { recursive: true });
  return rec;
}

export function uninstallPlugin(name: string, home = cediaHome()): void {
  const data = loadInstalled(home);
  if (!data.plugins[name]) throw new Error(`no plugin ${name}`);
  const rec = data.plugins[name]!;
  if (existsSync(rec.installPath)) rmSync(rec.installPath, { recursive: true, force: true });
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

export function updatePlugin(name: string, home = cediaHome()): InstalledPlugin {
  const data = loadInstalled(home);
  const rec = data.plugins[name];
  if (!rec) throw new Error(`no plugin ${name}`);
  // For local installs, just refresh timestamp; reinstall from installPath source not tracked.
  rec.lastUpdated = new Date().toISOString();
  data.plugins[name] = rec;
  saveInstalled(home, data);
  return rec;
}

// Marketplace registry (name -> source)
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
export function updateMarketplace(name: string, home = cediaHome()): void {
  // no-op for local registry; keeps interface
  const raw = readJson(marketplacesPath(home));
  if (!raw || !raw[name]) throw new Error(`no marketplace ${name}`);
}

export function discoverPlugins(home = cediaHome()): PluginManifest[] {
  // Home only. A repository must not add executable code the way it adds skills (markdown, inert): manifests
  // may name hooks and MCP servers that run outside the sandbox, so a workspace-writable plugin directory
  // would be a planting hole (Claude Code 2.1.309 closed the same hole around --plugin-dir).
  const dirs: string[] = [pluginsDir(home)];
  if (process.env.CEDIA_PLUGIN_SEED_DIR) dirs.push(process.env.CEDIA_PLUGIN_SEED_DIR);
  const out: PluginManifest[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      const m = loadManifest(join(d, name));
      if (m) out.push(m);
    }
  }
  return out;
}
