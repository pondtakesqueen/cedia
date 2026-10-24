import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { checkMcpServer } from '../config.ts';
import type { HookSpec, Hooks } from '../hooks.ts';
import { addMcp, listMcp, removeMcp, type McpAdd } from '../mcp/manage.ts';
import { inside, real } from '../project/instructions.ts';
import { frontMatter } from '../skills/skills.ts';
import type { ClaudeHook } from './claude-hooks.ts';
import { pluginsDir, readPlugins, writePlugins, type PluginFormat, type PluginRecord, type PluginSkill, type PluginSource } from './registry.ts';

// `cedia plugin add <git-url|owner/repo|folder>`: fetch a plugin, read whichever manifest it has, and write what
// cedia can use of it to the registry (core/plugins/registry.ts):
//
// - skills (`skills/<name>/SKILL.md`, or the folders the manifest names) load as they are;
// - commands (`commands/*.md`) and pi prompts (`prompts/*.md`) become skills, whose text says how the command's
//   `$ARGUMENTS` maps to what the person typed after it;
// - MCP servers (`.mcp.json`, `mcpServers`) are kept off until `cedia plugin mcp <name> on` copies them into the
//   user's mcpServers;
// - hooks (`hooks/hooks.json`, `hooks`) run through the Claude Code adapter (core/plugins/claude-hooks.ts) once
//   `cedia plugin hooks <name> on`;
// - agents, pi extensions, and the hook events and servers cedia cannot run are listed as skipped.
//
// A git source is cloned shallow with prompts off; a folder is copied, so later edits to it change nothing until
// `cedia plugin update`.

export type PluginAdd = { source: string; name?: string; ref?: string; plugin?: string };
export type PluginUpdate = { record: PluginRecord; changed: boolean; turnedOff: ('mcp' | 'hooks')[] };

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_MD = 256 * 1024;
const HOOK_TIMEOUT_MS = 60_000;
const HOOK_EVENTS: Record<string, keyof Hooks> = { PreToolUse: 'preToolUse', PostToolUse: 'postToolUse', Stop: 'stop' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/, '');
const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

// What the person typed: a folder, a git URL (a GitHub page of a folder too), `owner/repo`, `github:owner/repo`
// or pi's `git:host/owner/repo@ref`.
export function parseSource(arg: string, ref?: string, cwd = process.cwd()): PluginSource {
  if (arg.startsWith('npm:')) throw new Error('npm packages are not supported yet: give the git URL or a folder of the plugin');
  const pi = /^git:([^@]+?)(?:@([^@/]+))?$/.exec(arg);
  if (pi) return { git: `https://${pi[1]!.replace(/^https?:\/\//, '')}`, ...((ref ?? pi[2]) ? { ref: ref ?? pi[2] } : {}) };
  const gh = /^github:([\w.-]+\/[\w.-]+)$/.exec(arg);
  if (gh) return { git: `https://github.com/${gh[1]}.git`, ...(ref ? { ref } : {}) };
  const tree = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/tree\/([^/]+)(?:\/(.+?))?\/?$/.exec(arg);
  if (tree) return { git: `https://github.com/${tree[1]}.git`, ref: ref ?? tree[2]!, ...(tree[3] ? { subdir: tree[3] } : {}) };
  if (/^(https?|ssh|file):\/\//.test(arg) || /^[\w.-]+@[\w.-]+:/.test(arg)) return { git: arg, ...(ref ? { ref } : {}) };
  const path = resolve(cwd, expandHome(arg));
  if (existsSync(path)) return { path };
  if (/^[\w.-]+\/[\w.-]+$/.test(arg)) return { git: `https://github.com/${arg}.git`, ...(ref ? { ref } : {}) };
  throw new Error(`no folder ${arg}, and it is not a git URL or owner/repo`);
}

function git(args: string[], cwd?: string) {
  const r = Bun.spawnSync(['git', ...args], { ...(cwd ? { cwd } : {}), env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim().split('\n').slice(-2).join(' ')}`);
  return r.stdout.toString().trim();
}

// The source's files in `dest`; `root` is where the plugin is in them.
function fetchInto(src: PluginSource, dest: string): { root: string; commit?: string } {
  if ('git' in src) {
    const sha = src.ref && /^[0-9a-f]{40}$/.test(src.ref);
    git(['clone', '--quiet', ...(sha ? [] : ['--depth', '1']), ...(src.ref && !sha ? ['--branch', src.ref] : []), '--', src.git, dest]);
    if (sha) git(['checkout', '--quiet', src.ref!], dest);
  } else {
    if (!statSync(src.path).isDirectory()) throw new Error(`${src.path} is not a folder`);
    cpSync(src.path, dest, { recursive: true, filter: (p) => basename(p) !== '.git' });
  }
  const root = src.subdir ? resolve(dest, src.subdir) : dest;
  if (!inside(dest, root) || !existsSync(root)) throw new Error(`no folder ${src.subdir} in the plugin`);
  return { root, ...('git' in src ? { commit: git(['rev-parse', 'HEAD'], dest) } : {}) };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

// A marketplace (`.claude-plugin/marketplace.json`) with no plugin of its own at its root: the entry to install,
// as a source of its own.
function marketplaceEntry(root: string, src: PluginSource, pick?: string): PluginSource | undefined {
  if (existsSync(join(root, '.claude-plugin', 'plugin.json')) || existsSync(join(root, '.codex-plugin', 'plugin.json'))) return undefined;
  const m = readJson(join(root, '.claude-plugin', 'marketplace.json'));
  if (!isObject(m) || !Array.isArray(m.plugins)) return undefined;
  const entries = m.plugins.filter(isObject);
  const all = entries.map((e) => String(e.name));
  const names = all.length > 30 ? [...all.slice(0, 30), `and ${all.length - 30} more`] : all;
  const entry = pick ? entries.find((e) => e.name === pick) : entries.length === 1 ? entries[0] : undefined;
  if (!entry) throw new Error(pick ? `no plugin ${pick} in this marketplace (it has: ${names.join(', ')})` : `this is a marketplace of ${entries.length} plugins; pick one with --plugin <name> (${names.join(', ')})`);
  const s = entry.source;
  const pluginRoot = isObject(m.metadata) && typeof m.metadata.pluginRoot === 'string' ? m.metadata.pluginRoot : '.';
  if (typeof s === 'string') {
    const rel = s.startsWith('./') || s === '.' ? s : join(pluginRoot, s);
    const base = 'git' in src ? src : { path: src.path };
    return { ...base, subdir: join(src.subdir ?? '', rel) };
  }
  if (isObject(s) && s.source === 'github' && typeof s.repo === 'string') return { git: `https://github.com/${s.repo}.git`, ...refOf(s) };
  if (isObject(s) && s.source === 'url' && typeof s.url === 'string') return { git: s.url, ...refOf(s) };
  if (isObject(s) && s.source === 'git-subdir' && typeof s.url === 'string' && typeof s.path === 'string')
    return { git: /^[\w.-]+\/[\w.-]+$/.test(s.url) ? `https://github.com/${s.url}.git` : s.url, ...refOf(s), subdir: s.path };
  throw new Error(`plugin ${String(entry.name)} comes from a ${isObject(s) ? String(s.source) : 'kind of'} source, which cedia cannot fetch yet`);
}
const refOf = (s: Record<string, unknown>) => (typeof s.sha === 'string' ? { ref: s.sha } : typeof s.ref === 'string' ? { ref: s.ref } : {});

type Command = { name: string; content: string; description?: string; argumentHint?: string };
type Scan = {
  name?: string;
  version?: string;
  description?: string;
  format: PluginFormat;
  skills: string[];
  commands: Command[];
  mcp: [string, unknown][];
  hooks: unknown[];
  skipped: string[];
};

function manifestOf(root: string): { format: PluginFormat; manifest: Record<string, unknown> } {
  for (const [format, path] of [
    ['claude-code', '.claude-plugin/plugin.json'],
    ['codex', '.codex-plugin/plugin.json'],
  ] as const) {
    const m = readJson(join(root, path));
    if (isObject(m)) return { format, manifest: m };
  }
  const pkg = readJson(join(root, 'package.json'));
  if (isObject(pkg) && (isObject(pkg.pi) || (Array.isArray(pkg.keywords) && pkg.keywords.includes('pi-package')))) return { format: 'pi', manifest: { ...pkg, ...(isObject(pkg.pi) ? pkg.pi : {}), name: pkg.name } };
  return { format: 'skills', manifest: {} };
}

// The files a component path names, inside the plugin: a folder or a file, or for pi a glob.
function paths(root: string, entries: unknown[], skipped: string[], what: string): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (typeof e !== 'string' || e.startsWith('!')) continue;
    const matches = /[*?[]/.test(e) ? [...new Bun.Glob(e.replace(/^\.\//, '')).scanSync({ cwd: root, onlyFiles: false })].map((p) => join(root, p)) : [resolve(root, e)];
    for (const p of matches) {
      const r = real(p);
      if (!r || !inside(real(root) ?? root, r)) skipped.push(`${what} ${e}: not found inside the plugin`);
      else out.push(p);
    }
  }
  return out;
}

const dirs = (d: string) => {
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(d, e.name))
      .sort();
  } catch {
    return [];
  }
};

// Markdown files under a folder: commands/a/b.md is the command a:b, made a-b.
function markdown(d: string, depth: number, prefix = ''): [string, string][] {
  let entries;
  try {
    entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  return entries.flatMap((e): [string, string][] => {
    if (e.name.startsWith('.')) return [];
    if (e.isDirectory()) return depth > 0 ? markdown(join(d, e.name), depth - 1, `${prefix}${e.name}-`) : [];
    return e.name.endsWith('.md') ? [[`${prefix}${e.name.slice(0, -3)}`, join(d, e.name)]] : [];
  });
}

function command(name: string, file: string, skipped: string[], extra: Partial<Command> = {}): Command | undefined {
  try {
    if (statSync(file).size > MAX_MD) {
      skipped.push(`command ${name}: larger than ${MAX_MD} bytes`);
      return undefined;
    }
    const text = readFileSync(file, 'utf8');
    const fm = frontMatter(text);
    return { name, content: fm?.body ?? text, ...(fm?.fields.description ? { description: fm.fields.description } : {}), ...(fm?.fields['argument-hint'] ? { argumentHint: fm.fields['argument-hint'] } : {}), ...extra };
  } catch {
    skipped.push(`command ${name}: cannot be read`);
    return undefined;
  }
}

export function scanPlugin(root: string): Scan {
  const { format, manifest } = manifestOf(root);
  const skipped: string[] = [];
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  // Skills: skills/ and the folders the manifest adds, each one skill (it holds SKILL.md) or a folder of them.
  const skillRoots = [join(root, 'skills'), ...paths(root, list(manifest.skills), skipped, 'skills')];
  const skills: string[] = [];
  for (const d of skillRoots) for (const s of existsSync(join(d, 'SKILL.md')) ? [d] : dirs(d)) if (existsSync(join(s, 'SKILL.md'))) skills.push(s);
  if (!skills.length && manifest.skills === undefined && existsSync(join(root, 'SKILL.md'))) skills.push(root);
  // Commands: Claude Code's commands/ (or what the manifest names in its place) and pi's prompts/.
  const commands: Command[] = [];
  const cmdKey = format === 'pi' ? manifest.prompts : manifest.commands;
  const cmdDefault = join(root, format === 'pi' ? 'prompts' : 'commands');
  if (isObject(cmdKey) && format !== 'pi') {
    for (const [n, v] of Object.entries(cmdKey)) {
      if (!isObject(v)) continue;
      const extra = { ...(str(v.description) ? { description: str(v.description) } : {}), ...(str(v.argumentHint) ? { argumentHint: str(v.argumentHint) } : {}) };
      if (typeof v.content === 'string') commands.push({ name: n, content: v.content, ...extra });
      else if (typeof v.source === 'string') {
        const [p] = paths(root, [v.source], skipped, `command ${n}`);
        const c = p && command(n, p, skipped, extra);
        if (c) commands.push(c);
      }
    }
  } else {
    const from = cmdKey === undefined ? (existsSync(cmdDefault) ? [cmdDefault] : []) : paths(root, list(cmdKey), skipped, format === 'pi' ? 'prompts' : 'commands');
    for (const p of from) {
      const found: [string, string][] = statSync(p).isDirectory() ? markdown(p, format === 'pi' ? 0 : 3) : p.endsWith('.md') ? [[basename(p, '.md'), p]] : [];
      for (const [n, f] of found) {
        const c = command(n, f, skipped);
        if (c) commands.push(c);
      }
    }
  }
  // MCP servers: .mcp.json, then what the manifest declares; a later name replaces an earlier one.
  const mcp: [string, unknown][] = [];
  const addServers = (v: unknown, where: string) => {
    const map = isObject(v) && isObject(v.mcpServers) ? v.mcpServers : v;
    if (isObject(map)) mcp.push(...Object.entries(map));
    else if (v !== undefined) skipped.push(`MCP servers in ${where}: not a map of servers`);
  };
  if (existsSync(join(root, '.mcp.json'))) addServers(readJson(join(root, '.mcp.json')), '.mcp.json');
  for (const v of list(manifest.mcpServers)) {
    if (typeof v === 'string' && /\.(mcpb|dxt)$/.test(v)) skipped.push(`MCP bundle ${v}: bundles are not supported`);
    else if (typeof v === 'string') for (const p of paths(root, [v], skipped, 'mcpServers')) addServers(readJson(p), v);
    else addServers(v, 'the manifest');
  }
  // Hooks: hooks/hooks.json, then what the manifest declares (a file of {"hooks": {...}}, or the map itself).
  const hooks: unknown[] = [];
  const hooksFile = (p: string) => {
    const v = readJson(p);
    if (isObject(v) && isObject(v.hooks)) hooks.push(v.hooks);
  };
  if (format !== 'pi' && existsSync(join(root, 'hooks', 'hooks.json'))) hooksFile(join(root, 'hooks', 'hooks.json'));
  if (format !== 'pi')
    for (const v of list(manifest.hooks)) {
      if (typeof v === 'string') for (const p of paths(root, [v], skipped, 'hooks')) hooksFile(p);
      else if (isObject(v) && Object.keys(v).length) hooks.push(v);
    }
  // What cedia does not take.
  const agents = manifest.agents !== undefined ? paths(root, list(manifest.agents), skipped, 'agents') : markdown(join(root, 'agents'), 3).map(([, f]) => f);
  for (const a of agents) skipped.push(`agent ${relative(root, a)}: agents are not supported yet`);
  if (format === 'pi') {
    const ext = manifest.extensions !== undefined ? paths(root, list(manifest.extensions), skipped, 'extensions') : existsSync(join(root, 'extensions')) ? [join(root, 'extensions')] : [];
    for (const e of ext) skipped.push(`extension ${relative(root, e)}: pi extensions are code written for pi's own API`);
  }
  for (const [key, what] of [
    ['lspServers', 'LSP servers'],
    ['outputStyles', 'output styles'],
    ['userConfig', 'user configuration'],
    ['channels', 'channels'],
  ] as const)
    if (manifest[key] !== undefined) skipped.push(`${what}: not supported`);
  if (existsSync(join(root, '.lsp.json')) && manifest.lspServers === undefined) skipped.push('LSP servers (.lsp.json): not supported');
  return {
    ...(str(manifest.name) ? { name: str(manifest.name) } : {}),
    ...(str(manifest.version) ? { version: str(manifest.version) } : {}),
    ...(str(manifest.description) ? { description: str(manifest.description) } : {}),
    format,
    skills,
    commands,
    mcp,
    hooks,
    skipped,
  };
}

const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
const fill = (s: string, root: string, data: string) => s.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root).replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, data);

// A command as a skill: its text, after a line on what its placeholders stand for.
function commandSkill(c: Command, plugin: string, root: string, data: string): string {
  const description = oneLine(c.description ?? c.content.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? '') || `The /${c.name} command of plugin ${plugin}`;
  const lines = [`(This skill is /${c.name}, a command of the plugin ${plugin}. \`$ARGUMENTS\` in it stands for the text typed after the command, \`$1\`, \`$2\` and so on for its words, and \`\${1:-x}\` for the first word or x; with no text, work from the request.)`];
  if (/!`[^`]+`/.test(c.content)) lines.push('(A line written !`command` asked the harness to run that command and put its output there; run it yourself where you need the output.)');
  const front = [`name: ${c.name}`, `description: ${JSON.stringify(description.slice(0, 1024))}`, ...(c.argumentHint ? [`argument-hint: ${JSON.stringify(oneLine(c.argumentHint))}`] : [])];
  return `---\n${front.join('\n')}\n---\n${lines.join('\n')}\n\n${fill(c.content.trim(), root, data)}\n`;
}

// One server as cedia's mcpServers holds it, or why it cannot be.
function server(name: string, v: unknown, root: string, data: string): McpAdd | string {
  if (!isObject(v)) return 'not an object';
  if (JSON.stringify(v).includes('${user_config.')) return 'it needs user configuration, which cedia does not ask for';
  const f = (s: string) => fill(s, root, data);
  const strings = (x: unknown) => (isObject(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => typeof y === 'string').map(([k, y]) => [k, f(y as string)])) : undefined);
  const type = typeof v.type === 'string' ? v.type : typeof v.url === 'string' ? 'http' : 'stdio';
  let out: McpAdd;
  if (type === 'stdio' && typeof v.command === 'string') {
    const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string').map(f) : [];
    out = { command: f(v.command), ...(args.length ? { args } : {}), env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, ...strings(v.env) }, cwd: typeof v.cwd === 'string' ? f(v.cwd) : root };
  } else if ((type === 'http' || type === 'streamable-http') && typeof v.url === 'string') {
    const headers = strings(v.headers);
    out = { url: f(v.url), ...(headers && Object.keys(headers).length ? { headers } : {}) };
  } else return type === 'sse' || type === 'ws' ? `${type} servers are not supported (cedia speaks stdio and streamable HTTP)` : 'it has neither a command nor a url';
  try {
    checkMcpServer(name, out, {});
    return out;
  } catch (e) {
    return (e as Error).message;
  }
}

// The settings name of a plugin's server: <plugin>-<server> (just <plugin> when they are the same), as mcpServers
// allows it.
export const mcpName = (plugin: string, name: string) => (plugin === name ? plugin : `${plugin}-${name}`).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);

function hooksOf(maps: unknown[], plugin: string, root: string, data: string, skipped: string[]): Hooks {
  const out: Hooks = {};
  const skip = (s: string) => skipped.includes(s) || skipped.push(s);
  for (const map of maps) {
    if (!isObject(map)) continue;
    for (const [event, groups] of Object.entries(map)) {
      const target = HOOK_EVENTS[event];
      if (!target) {
        skip(`${event} hooks: cedia runs PreToolUse, PostToolUse and Stop hooks only`);
        continue;
      }
      for (const g of list(groups)) {
        if (!isObject(g)) continue;
        const matcher = typeof g.matcher === 'string' && g.matcher.trim() ? g.matcher : undefined;
        for (const h of list(g.hooks)) {
          if (!isObject(h)) continue;
          if (h.type !== 'command' || typeof h.command !== 'string') skip(`${event} ${String(h.type)} hooks: only command hooks are supported`);
          else if (h.async === true || h.asyncRewake === true) skip(`${event} hook ${h.command}: background hooks are not supported`);
          else if (h.shell === 'powershell') skip(`${event} hook ${h.command}: PowerShell hooks are not supported`);
          else if (h.command.includes('${user_config.') || (Array.isArray(h.args) && JSON.stringify(h.args).includes('${user_config.'))) skip(`${event} hook ${h.command}: it needs user configuration`);
          else {
            const exec = Array.isArray(h.args);
            const claude: ClaudeHook = { plugin, root, data, form: exec ? 'exec' : 'shell', ...(matcher && target !== 'stop' ? { matcher } : {}), ...(h.onFailure === 'block' || h.onFailure === 'continue' ? { onFailure: h.onFailure } : {}) };
            const spec: HookSpec = {
              command: exec ? [h.command, ...(h.args as unknown[]).map(String)] : [h.shell === 'bash' ? 'bash' : 'sh', '-c', h.command],
              timeoutMs: typeof h.timeout === 'number' && h.timeout > 0 ? h.timeout * 1000 : HOOK_TIMEOUT_MS,
              claude,
            };
            (out[target] ??= []).push(spec);
          }
        }
      }
    }
  }
  return out;
}

// The record for the plugin whose files are in `dir`/src (its manifest at `root`), with its commands written
// out as skills under `dir`/commands.
function buildRecord(name: string, dir: string, root: string, source: PluginSource, commit: string | undefined, prev?: PluginRecord): PluginRecord {
  const scan = scanPlugin(root);
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const skipped = [...scan.skipped];
  const skills: PluginSkill[] = [];
  const taken = new Set<string>();
  for (const d of scan.skills) {
    const fm = frontMatter(readFileSync(join(d, 'SKILL.md'), 'utf8'));
    const n = fm?.fields.name ?? basename(d);
    if (!fm || !NAME.test(n) || !fm.fields.description) {
      skipped.push(`skill ${relative(root, d) || '.'}: SKILL.md needs a name (lowercase, digits, -) and a description`);
      continue;
    }
    if (taken.has(n)) continue;
    taken.add(n);
    skills.push({ name: n, dir: d, from: 'skill' });
  }
  rmSync(join(dir, 'commands'), { recursive: true, force: true });
  for (const c of scan.commands) {
    const n = kebab(c.name);
    if (!NAME.test(n)) skipped.push(`command ${c.name}: cannot be named as a skill`);
    else if (taken.has(n)) skipped.push(`command ${c.name}: a skill of the same name comes first`);
    else {
      taken.add(n);
      const at = join(dir, 'commands', n);
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, 'SKILL.md'), commandSkill({ ...c, name: n }, name, root, data));
      skills.push({ name: n, dir: at, from: 'command' });
    }
  }
  const servers: Record<string, McpAdd> = {};
  for (const [n, v] of scan.mcp) {
    const s = server(mcpName(name, n), v, root, data);
    if (typeof s === 'string') skipped.push(`MCP server ${n}: ${s}`);
    else servers[n] = s;
  }
  const hooks = hooksOf(scan.hooks, name, root, data, skipped);
  return {
    name,
    ...(scan.version ? { version: scan.version } : {}),
    ...(scan.description ? { description: oneLine(scan.description) } : {}),
    format: scan.format,
    source,
    dir,
    root,
    ...(commit ? { commit } : {}),
    installedAt: prev?.installedAt ?? new Date().toISOString(),
    skills,
    mcp: { enabled: false, servers, added: [] },
    hooks: { enabled: false, list: hooks },
    skipped,
  };
}

function find(home: string, name: string): PluginRecord {
  const p = readPlugins(home).plugins.find((r) => r.name === name);
  if (!p) throw new Error(`no plugin ${name} installed (cedia plugin list)`);
  return p;
}

function save(home: string, record: PluginRecord) {
  const file = readPlugins(home);
  const at = file.plugins.findIndex((p) => p.name === record.name);
  if (at >= 0) file.plugins[at] = record;
  else file.plugins.push(record);
  writePlugins(home, file);
}

// Fetch into a fresh folder beside the plugins, following a marketplace to the plugin it names (`follow`; an
// update fetches the source recorded, which already names it).
function fetchPlugin(src: PluginSource, pick: string | undefined, base: string, follow = true): { tmp: string; root: string; source: PluginSource; commit?: string } {
  mkdirSync(base, { recursive: true });
  const tmp = join(base, `.fetch-${process.pid}-${Date.now()}`);
  try {
    let got = fetchInto(src, join(tmp, 'src'));
    const entry = follow ? marketplaceEntry(got.root, src, pick) : undefined;
    let source = src;
    if (entry) {
      source = entry;
      if ('git' in entry && (!('git' in src) || entry.git !== src.git || entry.ref !== src.ref)) {
        rmSync(join(tmp, 'src'), { recursive: true, force: true });
        got = fetchInto(entry, join(tmp, 'src'));
      } else {
        const root = resolve(join(tmp, 'src'), entry.subdir ?? '.');
        if (!inside(join(tmp, 'src'), root) || !existsSync(root)) throw new Error(`the marketplace names ${entry.subdir}, which is not in it`);
        got = { ...got, root };
      }
    }
    return { tmp, ...got, source };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export function addPlugin(home: string, opts: PluginAdd, base = pluginsDir()): PluginRecord {
  const src = parseSource(opts.source, opts.ref);
  const got = fetchPlugin(src, opts.plugin, base);
  try {
    const scanned = scanPlugin(got.root);
    const fallback = 'git' in got.source ? basename(got.source.subdir ?? got.source.git).replace(/\.git$/, '') : basename(got.source.subdir ?? got.source.path);
    const name = kebab(opts.name ?? scanned.name ?? fallback);
    if (!NAME.test(name)) throw new Error(`cannot name the plugin ${opts.name ?? scanned.name ?? fallback}; give --name`);
    if (readPlugins(home).plugins.some((p) => p.name === name)) throw new Error(`plugin ${name} is already installed (cedia plugin update ${name}, or --name for a second copy)`);
    const dir = join(base, name);
    if (existsSync(dir)) throw new Error(`${dir} is in the way; move it or give --name`);
    renameSync(got.tmp, dir);
    try {
      const record = buildRecord(name, dir, join(dir, relative(got.tmp, got.root)), got.source, got.commit);
      save(home, record);
      return record;
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  } finally {
    rmSync(got.tmp, { recursive: true, force: true });
  }
}

// Fetch the plugin again. When anything could have changed (a new commit, a folder copied again, other servers
// or hooks), its servers and hooks are turned off unless `keepEnabled`: they run its code outside the sandbox.
export function updatePlugin(home: string, name: string, keepEnabled = false, base = pluginsDir()): PluginUpdate {
  const prev = find(home, name);
  const got = fetchPlugin(prev.source, undefined, base, false);
  try {
    const root = got.root;
    const old = join(prev.dir, `src.old-${process.pid}`);
    renameSync(join(prev.dir, 'src'), old);
    renameSync(join(got.tmp, 'src'), join(prev.dir, 'src'));
    rmSync(old, { recursive: true, force: true });
    const next = buildRecord(name, prev.dir, join(prev.dir, relative(got.tmp, root)), prev.source, got.commit, prev);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const changed = !got.commit || got.commit !== prev.commit || !same(next.mcp.servers, prev.mcp.servers) || !same(next.hooks.list, prev.hooks.list);
    const turnedOff: PluginUpdate['turnedOff'] = [];
    for (const n of prev.mcp.added) if (listMcp().servers.some((s) => s.name === n)) removeMcp(n);
    save(home, next);
    if (prev.mcp.enabled && Object.keys(next.mcp.servers).length && (!changed || keepEnabled)) setPluginMcp(home, name, true);
    else if (prev.mcp.enabled) turnedOff.push('mcp');
    if (prev.hooks.enabled && (!changed || keepEnabled)) setPluginHooks(home, name, true);
    else if (prev.hooks.enabled) turnedOff.push('hooks');
    return { record: find(home, name), changed, turnedOff };
  } finally {
    rmSync(got.tmp, { recursive: true, force: true });
  }
}

export function removePlugin(home: string, name: string, base = pluginsDir()) {
  const p = find(home, name);
  if (p.mcp.enabled) setPluginMcp(home, name, false);
  const dir = real(p.dir);
  if (dir && inside(real(base) ?? base, dir) && dir !== (real(base) ?? base)) rmSync(dir, { recursive: true, force: true });
  const file = readPlugins(home);
  writePlugins(home, { plugins: file.plugins.filter((r) => r.name !== name) });
}

// On: each of the plugin's servers is added to the user's mcpServers as <plugin>-<server>. Off: taken out again.
export function setPluginMcp(home: string, name: string, on: boolean): PluginRecord {
  const p = find(home, name);
  const present = new Set(listMcp().servers.map((s) => s.name));
  for (const n of p.mcp.added) if (present.has(n)) removeMcp(n);
  const added: string[] = [];
  if (on) {
    if (!Object.keys(p.mcp.servers).length) throw new Error(`plugin ${name} has no MCP servers cedia can run`);
    for (const [n, s] of Object.entries(p.mcp.servers)) {
      const key = mcpName(name, n);
      if (present.has(key) && !p.mcp.added.includes(key)) throw new Error(`there is already an MCP server ${key} in settings; remove it first (cedia mcp remove ${key})`);
      addMcp(key, s);
      added.push(key);
    }
  }
  const next = { ...p, mcp: { ...p.mcp, enabled: on, added } };
  save(home, next);
  return next;
}

export function setPluginHooks(home: string, name: string, on: boolean): PluginRecord {
  const p = find(home, name);
  if (on && !Object.values(p.hooks.list).some((l) => l?.length)) throw new Error(`plugin ${name} has no hooks cedia can run`);
  const next = { ...p, hooks: { ...p.hooks, enabled: on } };
  save(home, next);
  return next;
}

export const getPlugin = find;
