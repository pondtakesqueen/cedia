import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PERMISSION_MODES, type PermissionMode, type Policy } from './safety/policy.ts';

export type Settings = { permissions?: { mode?: PermissionMode; allow?: string[]; deny?: string[] } };

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
