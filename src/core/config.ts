import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from './mcp/client.ts';
import { GUARDS, PERMISSION_SETTINGS, type Guard, type PermissionSetting, type Policy } from './safety/policy.ts';
import { DEFAULT_DOMAINS, SANDBOX_SETTINGS, type SandboxSetting } from './safety/sandbox.ts';
import { defaultHandoffAt } from './project/handoff.ts';
import { FALLBACKS, resolveModel } from './providers/catalog.ts';
import { secretPaths } from './safety/secrets.ts';
import { checkHooks, type Hooks } from './hooks.ts';
import type { ModelSpec, PrivacyLevel } from './types.ts';

export type Settings = {
  permissions?: { mode?: PermissionSetting; allow?: string[]; deny?: string[]; unlock?: Guard[] };
  checks?: string[];
  sandbox?: { mode?: SandboxSetting; allowedDomains?: string[] };
  privacy?: PrivacyLevel;
  // Standing facts about the user and their work, sent at the start of every session. User settings only.
  context?: string | string[];
  // Model (alias or ref) -> the model to continue on when its quota runs out, or "none". User settings only.
  fallback?: Record<string, string>;
  // The model for each role: an alias or ref, `claude-code[:<model>]` for plan and review, or "none". User
  // settings only: a repo must not pick what the user pays for.
  roles?: { plan?: string; code?: string; review?: string; swarm?: string; advisor?: string; classifier?: string };
  // Whether writer sessions get the spawn tool for sub-threads (default true), and "worktree" to run each work
  // sub-thread in a git worktree of its own, several at once. User settings only.
  spawn?: boolean | 'worktree';
  // Language servers for diagnostics after each edit: false turns them off; an object adds servers (or replaces a
  // known one of the same name) as { "<name>": { "command": [...], "extensions": [".x"] } }. User settings only:
  // a repo must not pick a command cedia runs.
  lsp?: boolean | Record<string, { command: string[]; extensions: string[] }>;
  // Whether writer sessions of a thread get ask_user, to end a run with a question for the owner (default false: a
  // headless run has nobody to answer). The desktop turns it on. User settings only.
  ask?: boolean;
  // Whether writer sessions of a thread get the todo tool, a list of steps kept as the thread's progress (default
  // false). The desktop turns it on. User settings only.
  todo?: boolean;
  // Named sets of defaults for a run, picked with --profile (core/profiles.ts). User settings only: a repo must not
  // pick a model or a permission.
  profiles?: Record<string, unknown>;
  // Tokens of context at which a session hands off to a new one, or "off". User settings only.
  handoffAt?: number | 'off';
  // How a session hands off: "note" (the model writes one) or "compact" (the provider summarizes, on models that
  // take compaction requests). User settings only.
  handoff?: 'note' | 'compact';
  // On a spent quota: "fallback" (the default), or "wait:<minutes>" to wait up to that long in all for it to come
  // back before falling back. User settings only: a repo must not keep the user waiting.
  onQuota?: string;
  // MCP servers whose tools the writer gets (core/mcp/tools.ts): a command to start, or a URL. User settings
  // only: a repository must not start programs. `${VAR}` in env values and headers is read from the environment.
  mcpServers?: Record<string, unknown>;
  // The desktop app's own settings (cedian: theme, keymap, layout and the like). cedia never reads them and checks
  // only that they are an object, so the desktop can keep them in this file without cedia knowing their shape.
  desktop?: Record<string, unknown>;
  // The user's hooks (core/hooks.ts). User settings only: a repo must not run code outside the sandbox.
  hooks?: Hooks;
};

// Every key cedia knows, with the keys allowed inside the objects it reads. A key that is not here is a typo or a
// setting from a newer cedia, and either way it would be silently ignored, so reading the file fails instead.
const SETTINGS_KEYS: Record<keyof Settings, readonly string[] | 'any'> = {
  permissions: ['mode', 'allow', 'deny', 'unlock'],
  checks: 'any',
  sandbox: ['mode', 'allowedDomains'],
  privacy: 'any',
  context: 'any',
  fallback: 'any',
  roles: ['plan', 'code', 'review', 'swarm', 'advisor', 'classifier'],
  spawn: 'any',
  lsp: 'any',
  ask: 'any',
  todo: 'any',
  profiles: 'any',
  handoffAt: 'any',
  handoff: 'any',
  onQuota: 'any',
  mcpServers: 'any',
  desktop: 'any',
  hooks: 'any',
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function checkSettings(value: unknown): Settings {
  if (!isObject(value)) throw new Error('settings must be a JSON object');
  for (const [key, inner] of Object.entries(value)) {
    const allowed = SETTINGS_KEYS[key as keyof Settings];
    if (!allowed) throw new Error(`unknown setting "${key}" (known: ${Object.keys(SETTINGS_KEYS).join(', ')})`);
    if (key === 'desktop' && !isObject(inner)) throw new Error('"desktop" must be an object');
    if (key === 'hooks') checkHooks(inner);
    if (allowed === 'any') continue;
    if (!isObject(inner)) throw new Error(`"${key}" must be an object`);
    const unknown = Object.keys(inner).find((k) => !allowed.includes(k));
    if (unknown) throw new Error(`unknown setting "${key}.${unknown}" (known: ${allowed.join(', ')})`);
  }
  return value as Settings;
}

// How a plan or review role runs: in cedia on a catalog model, or through the user's own Claude Code CLI.
export type RoleChoice = { via: 'cedia'; model: ModelSpec } | { via: 'claude-code'; model: string };

export const cediaHome = () => process.env.CEDIA_HOME ?? join(homedir(), '.cedia');

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  try {
    return checkSettings(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

const union = <T>(...lists: (T[] | undefined)[]) => [...new Set(lists.flatMap((l) => l ?? []))];

// The permission setting a run takes: flag > env > user settings > auto.
export function loadPermissionSetting(flag?: string, env = process.env): PermissionSetting {
  const setting = flag || env.CEDIA_PERMISSION || readSettings(join(cediaHome(), 'settings.json')).permissions?.mode || 'auto';
  if (!PERMISSION_SETTINGS.includes(setting as PermissionSetting)) throw new Error(`unknown permission mode "${setting}" (use ${PERMISSION_SETTINGS.join(', ')})`);
  return setting as PermissionSetting;
}

// Precedence: flags > env > user ~/.cedia/settings.json > auto. `auto` is workspace when the sandbox is on and
// read-only when it is not. Rule arrays union. A repo's own .cedia/settings.json can only add deny rules: a
// cloned repo must not grant itself writes or unlock a guard.
export function loadPolicy(
  cwd: string,
  flags: { mode?: string; allow?: string[]; deny?: string[]; unlock?: string[] } = {},
  env = process.env,
  sandboxOn = false,
): Policy {
  const user = readSettings(join(cediaHome(), 'settings.json')).permissions ?? {};
  const project = readSettings(join(cwd, '.cedia', 'settings.json')).permissions ?? {};
  const setting = loadPermissionSetting(flags.mode, env);
  const unlock = union<string>(flags.unlock, user.unlock);
  const unknown = unlock.find((g) => !GUARDS.includes(g as Guard));
  if (unknown) throw new Error(`unknown guard "${unknown}" to unlock (use ${GUARDS.join(', ')})`);
  return {
    mode: setting === 'auto' ? (sandboxOn ? 'workspace' : 'read-only') : setting === 'plan' ? 'read-only' : (setting as Policy['mode']),
    ...(setting === 'plan' ? { plan: true } : {}),
    allow: union(flags.allow, user.allow),
    deny: union(flags.deny, user.deny, project.deny),
    unlock: unlock as Guard[],
    secrets: secretPaths(cediaHome()),
  };
}

// Which models may see this repo: flags > CEDIA_PRIVACY > user settings > no-training. A repo may tighten it to
// zdr (a client's code, say) but never loosen it.
export function loadPrivacy(cwd: string, flag?: string, env = process.env): PrivacyLevel {
  const user = readSettings(join(cediaHome(), 'settings.json')).privacy;
  const project = readSettings(join(cwd, '.cedia', 'settings.json')).privacy;
  const level = flag || env.CEDIA_PRIVACY || user || 'no-training';
  if (!PRIVACY_LEVELS.includes(level as PrivacyLevel)) throw new Error(`unknown privacy level "${level}" (use ${PRIVACY_LEVELS.join(' or ')})`);
  return project === 'zdr' ? 'zdr' : (level as PrivacyLevel);
}
const PRIVACY_LEVELS: PrivacyLevel[] = ['no-training', 'zdr'];

// The user's standing context. A repo's settings cannot set it: a cloned repo must not speak as the user.
export function loadContext(): string | undefined {
  const c = readSettings(join(cediaHome(), 'settings.json')).context;
  const text = Array.isArray(c) ? c.join('\n') : c;
  return text?.trim() || undefined;
}

// The model a session continues on when `model`'s quota runs out: flag > user settings > the built-in FALLBACKS.
// "none" turns it off. A repo cannot set it, since the fallback is usually paid per token.
export function loadFallback(model: ModelSpec, flag?: string): ModelSpec | undefined {
  const user = readSettings(join(cediaHome(), 'settings.json')).fallback ?? {};
  const fromUser = Object.entries(user).find(([k]) => resolveModel(k).ref === model.ref)?.[1];
  const ref = flag ?? fromUser ?? FALLBACKS[model.ref];
  if (!ref || ref === 'none') return undefined;
  const fallback = resolveModel(ref);
  return fallback.ref === model.ref ? undefined : fallback;
}

// How long a run may wait for a spent quota that says when it comes back: flag > user settings > not at all
// (fall back at once). Returns milliseconds, or undefined for fallback.
export function loadQuotaWait(flag?: string): number | undefined {
  const raw = flag ?? readSettings(join(cediaHome(), 'settings.json')).onQuota ?? 'fallback';
  if (raw === 'fallback') return undefined;
  const minutes = Number(/^wait:(.+)$/.exec(raw)?.[1]);
  if (!(minutes > 0)) throw new Error(`on-quota must be fallback or wait:<minutes>: ${raw}`);
  return minutes * 60_000;
}

// Sub-threads: flag > user settings > on.
export type SpawnMode = 'on' | 'off' | 'worktree';
export function loadSpawn(flag?: string): SpawnMode {
  if (flag !== undefined && flag !== 'on' && flag !== 'off' && flag !== 'worktree') throw new Error(`--spawn must be on, off or worktree: ${flag}`);
  if (flag) return flag;
  const s = readSettings(join(cediaHome(), 'settings.json')).spawn ?? true;
  if (s !== true && s !== false && s !== 'worktree') throw new Error(`spawn in settings.json must be true, false or "worktree": ${JSON.stringify(s)}`);
  return s === 'worktree' ? 'worktree' : s ? 'on' : 'off';
}

// Language servers: flag (on|off) > user settings > the known ones that are installed.
export type LspSetting = NonNullable<Settings['lsp']>;
export function loadLsp(flag?: string): LspSetting | undefined {
  if (flag !== undefined && flag !== 'on' && flag !== 'off') throw new Error(`--lsp must be on or off: ${flag}`);
  if (flag === 'off') return false;
  const s = readSettings(join(cediaHome(), 'settings.json')).lsp;
  if (s === undefined || typeof s === 'boolean') return flag === 'on' ? true : s;
  if (!isObject(s)) throw new Error('"lsp" must be true, false or an object of servers');
  for (const [name, v] of Object.entries(s)) {
    const ok = isObject(v) && Array.isArray(v.command) && v.command.length > 0 && v.command.every((c) => typeof c === 'string') && Array.isArray(v.extensions) && v.extensions.every((e) => typeof e === 'string' && e.startsWith('.'));
    if (!ok) throw new Error(`lsp.${name} must be { "command": ["<program>", ...], "extensions": [".ext", ...] }`);
  }
  return s;
}

// ask_user: flag > user settings > off.
export function loadAsk(flag?: string): boolean {
  if (flag !== undefined && flag !== 'on' && flag !== 'off') throw new Error(`--ask must be on or off: ${flag}`);
  return flag ? flag === 'on' : (readSettings(join(cediaHome(), 'settings.json')).ask ?? false);
}

// todo: flag > user settings > off.
export function loadTodo(flag?: string): boolean {
  if (flag !== undefined && flag !== 'on' && flag !== 'off') throw new Error(`--todo must be on or off: ${flag}`);
  return flag ? flag === 'on' : (readSettings(join(cediaHome(), 'settings.json')).todo ?? false);
}

// The user's profiles as written, for core/profiles.ts to check.
export const loadProfiles = (): Record<string, unknown> => readSettings(join(cediaHome(), 'settings.json')).profiles ?? {};

// The user's MCP servers, checked: each a command (with args, env, cwd) or a URL (with headers), optionally
// readOnly and timeoutSec. A bad entry is an error, like any bad setting.
export function loadMcp(env = process.env): Record<string, McpServerConfig> {
  const raw = readSettings(join(cediaHome(), 'settings.json')).mcpServers ?? {};
  const expand = (v: string) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => env[k] ?? '');
  const strings = (v: unknown, what: string): Record<string, string> | undefined => {
    if (v === undefined) return undefined;
    if (!isObject(v) || Object.values(v).some((x) => typeof x !== 'string')) throw new Error(`${what} must map names to strings`);
    return Object.fromEntries(Object.entries(v as Record<string, string>).map(([k, x]) => [k, expand(x)]));
  };
  const out: Record<string, McpServerConfig> = {};
  for (const [name, v] of Object.entries(raw)) {
    const at = `mcpServers.${name}`;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error(`${at}: a server name is 1 to 32 letters, digits, _ or -`);
    if (!isObject(v)) throw new Error(`${at} must be an object`);
    const known = ['command', 'args', 'env', 'cwd', 'url', 'headers', 'readOnly', 'timeoutSec'];
    const unknown = Object.keys(v).find((k) => !known.includes(k));
    if (unknown) throw new Error(`${at}: unknown key "${unknown}" (known: ${known.join(', ')})`);
    if (v.readOnly !== undefined && typeof v.readOnly !== 'boolean') throw new Error(`${at}.readOnly must be true or false`);
    if (v.timeoutSec !== undefined && (typeof v.timeoutSec !== 'number' || !(v.timeoutSec > 0))) throw new Error(`${at}.timeoutSec must be a positive number`);
    const common = { ...(v.readOnly !== undefined ? { readOnly: v.readOnly as boolean } : {}), ...(v.timeoutSec !== undefined ? { timeoutSec: v.timeoutSec as number } : {}) };
    if (typeof v.command === 'string' && v.url === undefined) {
      if (v.args !== undefined && (!Array.isArray(v.args) || v.args.some((a) => typeof a !== 'string'))) throw new Error(`${at}.args must be a list of strings`);
      if (v.cwd !== undefined && typeof v.cwd !== 'string') throw new Error(`${at}.cwd must be a string`);
      const e = strings(v.env, `${at}.env`);
      out[name] = { command: v.command, ...(v.args ? { args: v.args as string[] } : {}), ...(e ? { env: e } : {}), ...(v.cwd ? { cwd: v.cwd as string } : {}), ...common };
    } else if (typeof v.url === 'string' && v.command === undefined) {
      if (!/^https?:\/\//.test(v.url)) throw new Error(`${at}.url must be http(s)`);
      const h = strings(v.headers, `${at}.headers`);
      out[name] = { url: v.url, ...(h ? { headers: h } : {}), ...common };
    } else throw new Error(`${at} needs either a command or a url`);
  }
  return out;
}

// When a writer session hands off: flag > user settings > half the window, capped (core/project/handoff.ts).
export function loadHandoffAt(model: ModelSpec, flag?: string): number | undefined {
  const raw = flag ?? readSettings(join(cediaHome(), 'settings.json')).handoffAt;
  if (raw === undefined) return defaultHandoffAt(model);
  if (raw === 'off') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000) throw new Error(`handoff-at must be a token count of at least 1000, or off: ${raw}`);
  return n;
}

// How a session hands off: flag > user settings > note. Compaction applies only where the model takes it; the
// client falls back to the note elsewhere.
export function loadHandoff(flag?: string): 'note' | 'compact' {
  const raw = flag ?? readSettings(join(cediaHome(), 'settings.json')).handoff ?? 'note';
  if (raw !== 'note' && raw !== 'compact') throw new Error(`handoff must be note or compact: ${raw}`);
  return raw;
}

// Roles: flags > CEDIA_MODEL (code only) > user settings > defaults (code: deepseek; plan and review: off).
// `claude-code` alone means opus for plan and sonnet for review. The writer always runs in cedia, where its
// writes go through the policy, the sandbox and the done gate.
export function loadRoles(
  flags: { plan?: string; code?: string; review?: string; swarm?: string; advisor?: string; classifier?: string } = {},
  env = process.env,
): { plan?: RoleChoice; code: ModelSpec; review?: RoleChoice; swarm: ModelSpec; advisor?: ModelSpec; classifier?: ModelSpec } {
  const user = readSettings(join(cediaHome(), 'settings.json')).roles ?? {};
  const codeRef = flags.code ?? env.CEDIA_MODEL ?? user.code ?? 'deepseek';
  if (/^claude-code\b/.test(codeRef)) throw new Error('the code role runs in cedia, where its writes are checked; use claude-code for plan or review');
  const role = (ref: string | undefined, claudeModel: string): RoleChoice | undefined => {
    if (!ref || ref === 'none') return undefined;
    const m = /^claude-code(?::(.+))?$/.exec(ref);
    return m ? { via: 'claude-code', model: m[1] ?? claudeModel } : { via: 'cedia', model: resolveModel(ref) };
  };
  const plan = role(flags.plan ?? user.plan, 'opus');
  const review = role(flags.review ?? user.review, 'sonnet');
  // Explore sub-threads: free and fast on the Go plan, and it keeps prompts without training on them.
  const swarm = resolveModel(flags.swarm ?? user.swarm ?? 'beam');
  // The advisor reads every turn, so it is off unless named: each turn of the writer costs one of its own.
  const advisorRef = flags.advisor ?? user.advisor;
  if (advisorRef && /^claude-code\b/.test(advisorRef)) throw new Error('the advisor runs in cedia, one reply a turn; claude-code is for plan or review');
  const advisor = advisorRef && advisorRef !== 'none' && advisorRef !== 'off' ? resolveModel(advisorRef) : undefined;
  // The classifier reads every command the mode alone would allow, so it too is off unless named.
  const classifierRef = flags.classifier ?? user.classifier;
  if (classifierRef && /^claude-code\b/.test(classifierRef)) throw new Error('the classifier runs in cedia, one reply a command; claude-code is for plan or review');
  const classifier = classifierRef && classifierRef !== 'none' && classifierRef !== 'off' ? resolveModel(classifierRef) : undefined;
  return { code: resolveModel(codeRef), ...(plan ? { plan } : {}), ...(review ? { review } : {}), swarm, ...(advisor ? { advisor } : {}), ...(classifier ? { classifier } : {}) };
}

// Declared checks for the done gate. Declaring a check grants nothing, so a repo may declare its own.
export function loadChecks(cwd: string, flags: string[] = []): string[] {
  const user = readSettings(join(cediaHome(), 'settings.json')).checks ?? [];
  const project = readSettings(join(cwd, '.cedia', 'settings.json')).checks ?? [];
  return [...new Set([...flags, ...project, ...user])];
}

// With no declared checks, the repo's own test command, so the done gate still asks for evidence. Detected
// checks are soft: the gate reminds once but never refuses, since the repo's tests may already fail.
export function detectChecks(cwd: string): string[] {
  const has = (f: string) => existsSync(join(cwd, f));
  if (has('package.json')) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      return [];
    }
    const pm = has('bun.lock') || has('bun.lockb') ? 'bun' : has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const test = scripts.test && !/no test specified/.test(scripts.test) ? [pm === 'bun' ? 'bun run test' : `${pm} test`] : [];
    return test.length ? test : has('bun.lock') || has('bunfig.toml') ? ['bun test'] : [];
  }
  if (has('Cargo.toml')) return ['cargo test'];
  if (has('go.mod')) return ['go test ./...'];
  if (has('Makefile') && /^test:/m.test(readFileSync(join(cwd, 'Makefile'), 'utf8'))) return ['make test'];
  if ((has('pyproject.toml') || has('pytest.ini') || has('setup.cfg')) && (has('tests') || has('test'))) return ['pytest'];
  return [];
}

// Sandbox: flags > CEDIA_SANDBOX > user settings > auto. Network grants come from the user only, never the repo.
export function loadSandbox(flags: { mode?: string; allowDomains?: string[] } = {}, env = process.env): { mode: SandboxSetting; allowedDomains: string[] } {
  const user = readSettings(join(cediaHome(), 'settings.json')).sandbox ?? {};
  const mode = flags.mode || env.CEDIA_SANDBOX || user.mode || 'auto';
  if (!SANDBOX_SETTINGS.includes(mode as SandboxSetting)) throw new Error(`unknown sandbox setting "${mode}" (use ${SANDBOX_SETTINGS.join(', ')})`);
  return { mode: mode as SandboxSetting, allowedDomains: [...new Set([...DEFAULT_DOMAINS, ...(user.allowedDomains ?? []), ...(flags.allowDomains ?? [])])] };
}

// Hooks come from the user's settings only; a repo's .cedia/settings.json may name them but they are never read.
export function loadHooks(): Hooks {
  return readSettings(join(cediaHome(), 'settings.json')).hooks ?? {};
}
