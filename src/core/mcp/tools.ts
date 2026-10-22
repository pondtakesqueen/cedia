import { clip, type ToolSpec } from '../tools/registry.ts';
import type { ToolDef } from '../types.ts';
import type { JsonObject } from '../types.ts';
import { McpClient, type McpCallResult, type McpServerConfig, type McpTool } from './client.ts';

// MCP servers the user configured (`mcpServers` in ~/.cedia/settings.json; a repository cannot add one, since a
// server is a program cedia would start), as tools named mcp__<server>__<tool>. They connect once per run, before
// the first request, and the tools keep one order for the whole run, so the tool list stays cacheable.
//
// cedia cannot know what a server's tool does, so each counts as `exec`: allowed in workspace mode, denied in a
// read-only session unless an allow rule names it (`--allow mcp__github__search`), and left out of read-only
// sub-threads and reviewers. A server the user marks `readOnly: true` counts as `read`. A server's own claims
// (its descriptions, annotations, results) are its words: results are tool output like any other.

const MAX_DESCRIPTION = 2_000;
const MAX_NAME = 64;

export type McpServers = { clients: McpClient[]; tools: ToolSpec[]; notes: string[]; close(): Promise<void> };

const part = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

// The text a call's result reaches the model as.
export function resultText(r: McpCallResult): string {
  const parts = (r.content ?? []).map((c) => {
    if (c.type === 'text') return c.text ?? '';
    if (c.type === 'image' || c.type === 'audio') return `[${c.type} ${c.mimeType ?? ''}, ${Math.round(((c.data?.length ?? 0) * 3) / 4)} bytes, not shown]`;
    if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
    if (c.type === 'resource_link') return `[resource ${(c as { uri?: string }).uri ?? ''}]`;
    return `[${c.type} content, not shown]`;
  });
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  return parts.join('\n') || '(no output)';
}

// A schema the providers take: an object at the top, without the keys some of them refuse.
function schemaOf(t: McpTool): JsonObject {
  const s: JsonObject = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : {};
  delete s.$schema;
  delete s.$id;
  return { ...s, type: 'object', properties: (s.properties as JsonObject | undefined) ?? {} };
}

export function mcpToolSpec(client: McpClient, t: McpTool, name: string): ToolSpec {
  return {
    name,
    description: `${(t.description ?? '').trim().slice(0, MAX_DESCRIPTION) || t.name} (MCP server ${client.name})`,
    schema: schemaOf(t),
    effect: client.config.readOnly ? 'read' : 'exec',
    replay: 'unsafe',
    async run(input, ctx) {
      try {
        const r = await client.call(t.name, input, ctx.signal);
        return { text: clip(resultText(r)), isError: r.isError === true };
      } catch (e) {
        return { text: `MCP server ${client.name}: ${(e as Error).message}`, isError: true };
      }
    },
  };
}

// A resumed session's tool whose server is not connected now: it keeps the definition the session was cached
// with, and a call says why it cannot run.
export function mcpStub(def: ToolDef): ToolSpec {
  const server = def.name.split('__')[1] ?? '?';
  return {
    ...def,
    effect: 'exec',
    replay: 'unsafe',
    async run() {
      return { text: `MCP server ${server} is not connected in this run (check mcpServers in ~/.cedia/settings.json), so ${def.name} cannot run`, isError: true };
    },
  };
}

// Starts every configured server and lists its tools. One that fails is left out with a note, and the run goes on.
export async function startMcp(servers: Record<string, McpServerConfig>): Promise<McpServers> {
  const notes: string[] = [];
  const started = await Promise.all(
    Object.entries(servers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([name, cfg]) => {
        let client: McpClient | undefined;
        try {
          // A command that cannot be started throws here.
          client = new McpClient(name, cfg);
          await client.connect();
          return { client, tools: (await client.tools()).sort((a, b) => a.name.localeCompare(b.name)) };
        } catch (e) {
          notes.push(`cedia: MCP server ${name} did not start: ${(e as Error).message}; going on without it`);
          await client?.close();
          return undefined;
        }
      }),
  );
  const tools: ToolSpec[] = [];
  const taken = new Set<string>();
  for (const s of started) {
    if (!s) continue;
    for (const t of s.tools) {
      let name = `mcp__${part(s.client.name)}__${part(t.name)}`.slice(0, MAX_NAME);
      for (let i = 2; taken.has(name); i++) name = `${name.slice(0, MAX_NAME - String(i).length - 1)}_${i}`;
      taken.add(name);
      tools.push(mcpToolSpec(s.client, t, name));
    }
  }
  const clients = started.flatMap((s) => (s ? [s.client] : []));
  return { clients, tools, notes, close: async () => void (await Promise.all(clients.map((c) => c.close()))) };
}
