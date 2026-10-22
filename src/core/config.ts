import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GUARDS, PERMISSION_SETTINGS, type Guard, type PermissionSetting, type Policy } from './safety/policy.ts';
import { DEFAULT_DOMAINS, SANDBOX_SETTINGS, type SandboxSetting } from './safety/sandbox.ts';
import { defaultHandoffAt } from './project/handoff.ts';
import { FALLBACKS, resolveModel } from './providers/catalog.ts';
import { secretPaths } from './safety/secrets.ts';
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
  roles?: { plan?: string; code?: string; review?: string; swarm?: string };
  // Whether writer sessions get the spawn tool for sub-threads (default true), and "worktree" to run each work
  // sub-thread in a git worktree of its own, several at once. User settings only.
  spawn?: boolean | 'worktree';
  // Whether writer sessions of a thread get ask_user, to end a run with a question for the owner (default false: a
  // headless run has nobody to answer). The desktop turns it on. User settings only.
  ask?: boolean;
  // Tokens of context at which a session hands off to a new one, or "off". User settings only.
  handoffAt?: number | 'off';
  // How a session hands off: "note" (the model writes one) or "compact" (the provider summarizes, on models that
  // take compaction requests). User settings only.
  handoff?: 'note' | 'compact';
  // On a spent quota: "fallback" (the default), or "wait:<minutes>" to wait up to that long in all for it to come
  // back before falling back. User settings only: a repo must not keep the user waiting.
  onQuota?: string;
  // The desktop app's own settings (cedian: theme, keymap, layout and the like). cedia never reads them and checks
  // only that they are an object, so the desktop can keep them in this file without cedia knowing their shape.
  desktop?: Record<string, unknown>;
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
  roles: ['plan', 'code', 'review', 'swarm'],
  spawn: 'any',
  ask: 'any',
  handoffAt: 'any',
  handoff: 'any',
  onQuota: 'any',
  desktop: 'any',
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function checkSettings(value: unknown): Settings {
  if (!isObject(value)) throw new Error('settings must be a JSON object');
  for (const [key, inner] of Object.entries(value)) {
    const allowed = SETTINGS_KEYS[key as keyof Settings];
    if (!allowed) throw new Error(`unknown setting "${key}" (known: ${Object.keys(SETTINGS_KEYS).join(', ')})`);
    if (key === 'desktop' && !isObject(inner)) throw new Error('"desktop" must be an object');
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
  const setting = flags.mode || env.CEDIA_PERMISSION || user.mode || 'auto';
  if (!PERMISSION_SETTINGS.includes(setting as PermissionSetting)) throw new Error(`unknown permission mode "${setting}" (use ${PERMISSION_SETTINGS.join(', ')})`);
  const unlock = union<string>(flags.unlock, user.unlock);
  const unknown = unlock.find((g) => !GUARDS.includes(g as Guard));
  if (unknown) throw new Error(`unknown guard "${unknown}" to unlock (use ${GUARDS.join(', ')})`);
  return {
    mode: setting === 'auto' ? (sandboxOn ? 'workspace' : 'read-only') : (setting as Policy['mode']),
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

// ask_user: flag > user settings > off.
export function loadAsk(flag?: string): boolean {
  if (flag !== undefined && flag !== 'on' && flag !== 'off') throw new Error(`--ask must be on or off: ${flag}`);
  return flag ? flag === 'on' : (readSettings(join(cediaHome(), 'settings.json')).ask ?? false);
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
  flags: { plan?: string; code?: string; review?: string; swarm?: string } = {},
  env = process.env,
): { plan?: RoleChoice; code: ModelSpec; review?: RoleChoice; swarm: ModelSpec } {
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
  return { code: resolveModel(codeRef), ...(plan ? { plan } : {}), ...(review ? { review } : {}), swarm };
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
