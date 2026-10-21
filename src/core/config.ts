import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GUARDS, PERMISSION_SETTINGS, type Guard, type PermissionSetting, type Policy } from './safety/policy.ts';
import { DEFAULT_DOMAINS, SANDBOX_SETTINGS, type SandboxSetting } from './safety/sandbox.ts';
import { secretPaths } from './safety/secrets.ts';
import type { PrivacyLevel } from './types.ts';

export type Settings = {
  permissions?: { mode?: PermissionSetting; allow?: string[]; deny?: string[]; unlock?: Guard[] };
  checks?: string[];
  sandbox?: { mode?: SandboxSetting; allowedDomains?: string[] };
  privacy?: PrivacyLevel;
  // Standing facts about the user and their work, sent at the start of every session. User settings only.
  context?: string | string[];
};

export const cediaHome = () => process.env.CEDIA_HOME ?? join(homedir(), '.cedia');

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
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

// Declared checks for the done gate. Declaring a check grants nothing, so a repo may declare its own.
export function loadChecks(cwd: string, flags: string[] = []): string[] {
  const user = readSettings(join(cediaHome(), 'settings.json')).checks ?? [];
  const project = readSettings(join(cwd, '.cedia', 'settings.json')).checks ?? [];
  return [...new Set([...flags, ...project, ...user])];
}

// Sandbox: flags > CEDIA_SANDBOX > user settings > auto. Network grants come from the user only, never the repo.
export function loadSandbox(flags: { mode?: string; allowDomains?: string[] } = {}, env = process.env): { mode: SandboxSetting; allowedDomains: string[] } {
  const user = readSettings(join(cediaHome(), 'settings.json')).sandbox ?? {};
  const mode = flags.mode || env.CEDIA_SANDBOX || user.mode || 'auto';
  if (!SANDBOX_SETTINGS.includes(mode as SandboxSetting)) throw new Error(`unknown sandbox setting "${mode}" (use ${SANDBOX_SETTINGS.join(', ')})`);
  return { mode: mode as SandboxSetting, allowedDomains: [...new Set([...DEFAULT_DOMAINS, ...(user.allowedDomains ?? []), ...(flags.allowDomains ?? [])])] };
}
