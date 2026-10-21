import type { JsonObject, ToolDef, ToolEffect, ToolOutput } from '../types.ts';

export type ToolCtx = { cwd: string; signal: AbortSignal };

export type ToolSpec = ToolDef & {
  effect: ToolEffect;
  replay: 'safe' | 'unsafe';
  run(input: JsonObject, ctx: ToolCtx): Promise<ToolOutput>;
};

// Tool definitions as the model sees them, in a fixed order (cache rule 1).
export function toolDefs(tools: ToolSpec[]): ToolDef[] {
  return tools.map(({ name, description, schema }) => ({ name, description, schema }));
}

export const MAX_OUTPUT_CHARS = 30_000;

export function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max / 2);
  const tail = text.slice(-max / 2);
  return `${head}\n\n[... ${text.length - max} characters cut ...]\n\n${tail}`;
}
