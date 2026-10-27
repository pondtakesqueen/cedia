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

export type McpServers = { clients: McpClient[]; tools: ToolSpec[]; index: { name: string; description: string }[]; notes: string[]; close(): Promise<void> };

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

// A schema the providers take: an object at the top, without the keys some of them refuse. A schema they would
// refuse anyway (properties not an object, required not a list of names) or one too big for every request to
// carry becomes an open object, so one server's tool cannot break each request of the run.
const MAX_SCHEMA_CHARS = 16_000;
function schemaOf(t: McpTool): JsonObject {
  const s: JsonObject = t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema) ? { ...t.inputSchema } : {};
  delete s.$schema;
  delete s.$id;
  const props = s.properties ?? {};
  const okProps = typeof props === 'object' && props !== null && !Array.isArray(props) && Object.values(props).every((v) => typeof v === 'object' && v !== null && !Array.isArray(v));
  const okRequired = s.required === undefined || (Array.isArray(s.required) && s.required.every((r) => typeof r === 'string'));
  const out: JsonObject = { ...s, type: 'object', properties: okProps ? (props as JsonObject) : {} };
  if (!okProps || !okRequired || JSON.stringify(out).length > MAX_SCHEMA_CHARS) return { type: 'object', properties: {}, additionalProperties: true };
  return out;
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

// Connects, retrying a remote server that answers late: all of this happens before the first request,
// so the tool list is still fixed for the run and a slow server makes the initial list instead of a
// mid-run addition (which would break the cached prefix). Local spawns fail deterministically (a missing
// binary), so they get one attempt; remote servers get three, 1s then 2s apart.
export async function connectWithRetry(client: McpClient, remote: boolean, sleep: (ms: number) => Promise<void>): Promise<{ attempts: number }> {
  const tries = remote ? 3 : 1;
  let error: unknown;
  for (let n = 1; ; n++) {
    try {
      await client.connect();
      return { attempts: n };
    } catch (e) {
      error = e;
      if (n >= tries) throw error;
      await sleep(1000 * n);
    }
  }
}

// Definition budget: past this many characters of MCP tool definitions, tools after it go out stripped
// (name, first line of description, open schema) with their full text searchable through ToolSearch, instead
// of every tool of a big server riding each request's cached prefix (208 tools of one server were ~400k
// characters a request). Under the budget everything stays full, exactly as before. The split walks servers
// then tools, both already sorted, so the list stays fixed for the run; calls still resolve by name, so the
// loop, the linter and the session shape need no change.
export const MCP_DEF_BUDGET = 32_000;
const DEFERRED_DESC = 160;

const defChars = (spec: ToolSpec) => JSON.stringify({ name: spec.name, description: spec.description, schema: spec.schema }).length;

export function budgetMcpTools(specs: ToolSpec[]): { tools: ToolSpec[]; index: { name: string; description: string }[] } {
  let used = 0;
  const tools: ToolSpec[] = [];
  const index: { name: string; description: string }[] = [];
  for (const spec of specs) {
    const chars = defChars(spec);
    if (used + chars <= MCP_DEF_BUDGET) {
      used += chars;
      tools.push(spec);
      continue;
    }
    const first = spec.description.split('\n')[0]!.slice(0, DEFERRED_DESC);
    tools.push({ ...spec, description: `${first} (full usage: search ToolSearch for ${spec.name})`, schema: { type: 'object', additionalProperties: true } });
    index.push({ name: spec.name, description: spec.description });
  }
  return { tools, index };
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
export async function startMcp(servers: Record<string, McpServerConfig>, sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms))): Promise<McpServers> {
  const notes: string[] = [];
  const started = await Promise.all(
    Object.entries(servers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([name, cfg]) => {
        let client: McpClient | undefined;
        try {
          // A command that cannot be started throws here.
          client = new McpClient(name, cfg);
          await connectWithRetry(client, 'url' in cfg, sleep);
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
  const { tools: budgeted, index } = budgetMcpTools(tools);
  return { clients, tools: budgeted, index, notes, close: async () => void (await Promise.all(clients.map((c) => c.close()))) };
}
