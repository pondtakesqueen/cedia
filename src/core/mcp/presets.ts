import type { McpAdd } from './manage.ts';

// Ready-made MCP servers for what cedia leaves to MCP (SPEC: search is not built in), so `cedia mcp add search
// --preset tavily` is all it takes. The key is never written into settings: the entry names its variable as
// `${VAR}`, which checkMcpServer reads from the environment each time a run starts the server.
//
// A search server is marked readOnly, so read-only, plan and review sessions may search too: its tools send a
// query to one provider and change nothing.

export type McpPreset = {
  name: string;
  description: string;
  // The variable the key is read from, and where to get one.
  keyEnv: string;
  keyUrl: string;
  server: McpAdd;
};

export const MCP_PRESETS: McpPreset[] = [
  {
    name: 'tavily',
    description: 'Tavily web search and page extraction, through its hosted server (no local install)',
    keyEnv: 'TAVILY_API_KEY',
    keyUrl: 'https://app.tavily.com',
    server: { url: 'https://mcp.tavily.com/mcp/', headers: { Authorization: 'Bearer ${TAVILY_API_KEY}' }, readOnly: true },
  },
  {
    name: 'brave',
    description: 'Brave web, news, image and video search, run locally with npx (needs Node)',
    keyEnv: 'BRAVE_API_KEY',
    keyUrl: 'https://brave.com/search/api/',
    server: { command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' }, readOnly: true },
  },
];

export function mcpPreset(name: string): McpPreset {
  const p = MCP_PRESETS.find((x) => x.name === name);
  if (!p) throw new Error(`no MCP preset ${name} (known: ${MCP_PRESETS.map((x) => x.name).join(', ')})`);
  return p;
}
