import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PERMISSION_MODES, type PermissionMode, type Policy } from './safety/policy.ts';
import { DEFAULT_DOMAINS, SANDBOX_SETTINGS, type SandboxSetting } from './safety/sandbox.ts';

export type Settings = {
  permissions?: { mode?: PermissionMode; allow?: string[]; deny?: string[] };
  checks?: string[];
  sandbox?: { mode?: SandboxSetting; allowedDomains?: string[] };
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

// Precedence: flags > env > user ~/.cedia/settings.json > read-only. Rule arrays union.
// A repo's own .cedia/settings.json can only add deny rules: a cloned repo must not grant itself writes.
export function loadPolicy(cwd: string, flags: { mode?: string; allow?: string[]; deny?: string[] } = {}, env = process.env): Policy {
  const user = readSettings(join(cediaHome(), 'settings.json')).permissions ?? {};
  const project = readSettings(join(cwd, '.cedia', 'settings.json')).permissions ?? {};
  const mode = flags.mode || env.CEDIA_PERMISSION || user.mode || 'read-only';
  if (!PERMISSION_MODES.includes(mode as PermissionMode)) throw new Error(`unknown permission mode "${mode}" (use ${PERMISSION_MODES.join(' or ')})`);
  const union = (...lists: (string[] | undefined)[]) => [...new Set(lists.flatMap((l) => l ?? []))];
  return { mode: mode as PermissionMode, allow: union(flags.allow, user.allow), deny: union(flags.deny, user.deny, project.deny) };
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
