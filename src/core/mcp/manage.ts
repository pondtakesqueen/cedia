import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cediaHome, checkMcpServer, checkSettings } from '../config.ts';
import { McpClient } from './client.ts';

// `cedia mcp`: the user's MCP servers (`mcpServers` in ~/.cedia/settings.json) for a client's settings page, which
// lists them, checks one by starting it, and adds or removes one. cedia stays the only writer of the keys it reads:
// a client never edits mcpServers itself. A listing names the env variables and headers a server takes but never
// their values, which are often tokens.

export type McpEntry = {
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  // The names only.
  env?: string[];
  headers?: string[];
  readOnly?: boolean;
  timeoutSec?: number;
  // Why cedia would refuse this entry; a run fails on it until it is fixed or removed.
  error?: string;
};
export type McpList = { servers: McpEntry[] };
// What starting a server found: its tools, or why it did not start.
export type McpCheck = { name: string; ok: true; tools: { name: string; description?: string }[] } | { name: string; ok: false; error: string };
// What `cedia mcp add` takes: one server, as mcpServers holds it.
export type McpAdd = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; readOnly?: boolean; timeoutSec?: number } | { url: string; headers?: Record<string, string>; readOnly?: boolean; timeoutSec?: number };

const settingsPath = () => join(cediaHome(), 'settings.json');

function readRaw(path = settingsPath()): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return checkSettings(JSON.parse(readFileSync(path, 'utf8'))) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

// Written whole through a temporary file, so a reader never sees half of it.
function writeRaw(settings: Record<string, unknown>, path = settingsPath()) {
  checkSettings(settings);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, path);
}

const servers = (s: Record<string, unknown>) => (s.mcpServers ?? {}) as Record<string, unknown>;

export function listMcp(): McpList {
  return {
    servers: Object.entries(servers(readRaw()))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]): McpEntry => {
        const raw = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
        const shown: McpEntry = {
          name,
          ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
          ...(Array.isArray(raw.args) ? { args: raw.args.filter((a): a is string => typeof a === 'string') } : {}),
          ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
          ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
          ...(raw.env && typeof raw.env === 'object' ? { env: Object.keys(raw.env) } : {}),
          ...(raw.headers && typeof raw.headers === 'object' ? { headers: Object.keys(raw.headers) } : {}),
          ...(typeof raw.readOnly === 'boolean' ? { readOnly: raw.readOnly } : {}),
          ...(typeof raw.timeoutSec === 'number' ? { timeoutSec: raw.timeoutSec } : {}),
        };
        try {
          checkMcpServer(name, v);
          return shown;
        } catch (e) {
          return { ...shown, error: (e as Error).message };
        }
      }),
  };
}

// Starts the server as a run would, lists its tools and stops it.
export async function checkMcp(name: string): Promise<McpCheck> {
  const v = servers(readRaw())[name];
  if (v === undefined) return { name, ok: false, error: `no MCP server ${name} in ${settingsPath()}` };
  let client: McpClient | undefined;
  try {
    client = new McpClient(name, checkMcpServer(name, v));
    await client.connect();
    const tools = (await client.tools()).sort((a, b) => a.name.localeCompare(b.name));
    return { name, ok: true, tools: tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description.trim().split('\n')[0]! } : {}) })) };
  } catch (e) {
    return { name, ok: false, error: (e as Error).message };
  } finally {
    await client?.close();
  }
}

// Adds the server, or replaces the one of that name. An entry cedia would refuse is refused here instead.
export function addMcp(name: string, server: McpAdd): void {
  checkMcpServer(name, server);
  const settings = readRaw();
  writeRaw({ ...settings, mcpServers: { ...servers(settings), [name]: server } });
}

export function removeMcp(name: string): void {
  const settings = readRaw();
  const { [name]: gone, ...rest } = servers(settings);
  if (gone === undefined) throw new Error(`no MCP server ${name} in ${settingsPath()}`);
  writeRaw({ ...settings, mcpServers: rest });
}
