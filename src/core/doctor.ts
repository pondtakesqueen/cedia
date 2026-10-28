// `cedia doctor`: one read-only pass over versions, user settings, MCP config and the sandbox. Pure data out; cli.ts prints it (text and --json), and the TUIs can adopt it instead of
// their inline copies. Nothing here starts a server or touches the network.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome, checkSettings } from './config.ts';
import { listMcp } from './mcp/manage.ts';
import { versionInfo } from '../protocol/version.ts';

export type TierStatus = { present: boolean; ok: boolean; error?: string };

const tier = (present: boolean, load: () => unknown): TierStatus => {
  if (!present) return { present: false, ok: true };
  try {
    load();
    return { present: true, ok: true };
  } catch (e) {
    return { present: true, ok: false, error: (e as Error).message };
  }
};

export type DoctorReport = {
  version: string;
  protocol: string;
  bun: string;
  home: string;
  cwd: string;
  settings: { user: TierStatus };
  sandbox: { available: boolean; tool: string | null };
  mcp: { servers: { name: string; error?: string }[] };
};

export function doctorReport(cwd: string, home = cediaHome()): DoctorReport {
  const info = versionInfo();
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
  const readUserSettings = () => {
    const path = join(home, 'settings.json');
    try {
      return checkSettings(readJson(path));
    } catch (e) {
      throw new Error(`${path}: ${(e as Error).message}`);
    }
  };
  const tool = Bun.which('bwrap') ?? Bun.which('sandbox-exec') ?? null;
  let servers: DoctorReport['mcp']['servers'] = [];
  try {
    servers = listMcp().servers.map((s) => ({ name: s.name, ...('error' in s && typeof s.error === 'string' ? { error: s.error } : {}) }));
  } catch {
    servers = [];
  }
  return {
    version: info.version,
    protocol: info.protocol,
    bun: Bun.version,
    home,
    cwd,
    settings: {
      user: tier(existsSync(join(home, 'settings.json')), readUserSettings),
    },
    sandbox: { available: tool !== null, tool },
    mcp: { servers },
  };
}
