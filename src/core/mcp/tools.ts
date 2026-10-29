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

// `tools` go in the tool list as they are; `deferred` run through mcp_call (in `tools` when there are any), and
// `index` is their text for ToolSearch.
export type McpServers = { clients: McpClient[]; tools: ToolSpec[]; deferred: ToolSpec[]; index: DeferredEntry[]; notes: string[]; close(): Promise<void> };

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

// Definition budget: past this many characters of MCP tool definitions, the tools after it are kept out of the
// tool list, their full text and schema searchable through ToolSearch, and the model runs one through a single
// tool, mcp_call, instead of every tool of a big server riding each request's cached prefix. Stubs (name, first
// line, open schema) went first: 208 tools of one server came down from ~400k characters to ~110k, still about
// 41k tokens of a 46k first request on Haiku, since every definition costs tokens of its own however short it is.
// Under the budget everything stays in the list, exactly as before. The split walks servers then tools, both
// already sorted, so the list stays fixed for the run.
export const MCP_DEF_BUDGET = 32_000;
export const MCP_CALL_TOOL = 'mcp_call';

const defChars = (spec: ToolSpec) => JSON.stringify({ name: spec.name, description: spec.description, schema: spec.schema }).length;

export type DeferredEntry = { name: string; description: string; schema: JsonObject };

export function budgetMcpTools(specs: ToolSpec[]): { tools: ToolSpec[]; deferred: ToolSpec[]; index: DeferredEntry[] } {
  let used = 0;
  const tools: ToolSpec[] = [];
  const deferred: ToolSpec[] = [];
  for (const spec of specs) {
    const chars = defChars(spec);
    if (used + chars <= MCP_DEF_BUDGET) {
      used += chars;
      tools.push(spec);
    } else deferred.push(spec);
  }
  return { tools, deferred, index: deferred.map(({ name, description, schema }) => ({ name, description, schema })) };
}

// Runs an MCP tool kept out of the tool list. The policy and the classifier judge the call as the tool it names,
// with that tool's input, and hook matchers match it (ToolSpec.via), so `--allow mcp__github__search` and a read-only server mean
// what they mean for a listed tool. `tools` is what this session may run: a reviewer's or sub-thread's holds the
// read-only ones only.
export function mcpCallTool(tools: ToolSpec[]): ToolSpec {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const target = (input: JsonObject) => (typeof input.tool === 'string' ? byName.get(input.tool) : undefined);
  const args = (input: JsonObject): JsonObject => (input.input && typeof input.input === 'object' && !Array.isArray(input.input) ? (input.input as JsonObject) : {});
  return {
    name: MCP_CALL_TOOL,
    description: `Run an MCP server tool that is not in your tool list. Find it with ToolSearch first, which gives its exact name, what it does and its input schema. ${tools.length} tools of ${new Set(tools.map((t) => t.name.split('__')[1])).size} server(s) are reached this way.`,
    schema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'The exact name ToolSearch gave, mcp__<server>__<tool>' },
        input: { type: 'object', description: "The tool's input, as its schema says" },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    effect: 'exec',
    replay: 'unsafe',
    via(input) {
      const spec = target(input);
      return spec ? { spec, input: args(input) } : undefined;
    },
    async run(input, ctx) {
      const spec = target(input);
      if (!spec) return { text: `no MCP tool named ${String(input.tool ?? '')} can run here; search ToolSearch for the exact name`, isError: true };
      return spec.run(args(input), ctx);
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
  const { tools: listed, deferred, index } = budgetMcpTools(tools);
  return { clients, tools: listed, deferred, index, notes, close: async () => void (await Promise.all(clients.map((c) => c.close()))) };
}
