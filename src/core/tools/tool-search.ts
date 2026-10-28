import type { ToolSpec } from './registry.ts';

export type DeferredTool = { name: string; description: string; defer_loading?: boolean };

const deferred: DeferredTool[] = [];

export function registerDeferred(tool: DeferredTool) {
  if (!deferred.some((t) => t.name === tool.name)) deferred.push(tool);
}
export function clearDeferred() { deferred.length = 0; }

function score(t: DeferredTool, q: string): number {
  const name = t.name.toLowerCase();
  const desc = t.description.toLowerCase();
  const ql = q.toLowerCase();
  if (name === ql) return 100;
  if (name.includes(ql)) return 50;
  if (desc.includes(ql)) return 20;
  // keyword tokens
  const tokens = ql.split(/\s+/).filter(Boolean);
  let s = 0;
  for (const tok of tokens) {
    if (name.includes(tok)) s += 10;
    if (desc.includes(tok)) s += 5;
  }
  return s;
}

export const toolSearchTool: ToolSpec = {
  name: 'ToolSearch',
  description: 'Search tools by keyword or select:<name>. MCP server tools (mcp__*) live here: search what you want, then call the exact name.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  effect: 'read',
  replay: 'safe',
  async run(input, _ctx) {
    const query = String(input.query ?? '');
    const max = Math.max(1, Math.min(20, Number(input.max_results ?? 5)));
    // select:<name>
    const sel = /^select:(.+)$/.exec(query.trim());
    if (sel) {
      const name = sel[1]!.trim();
      const t = deferred.find((d) => d.name === name);
      if (!t) return { text: 'no tool found', isError: true };
      return { text: JSON.stringify([t]), isError: false };
    }
    const ranked = deferred
      .map((t) => ({ t, s: score(t, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, max)
      .map((x) => x.t);
    if (!ranked.length) return { text: 'no tools found', isError: false };
    return { text: JSON.stringify(ranked), isError: false };
  },
};
