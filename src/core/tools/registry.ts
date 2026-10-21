import type { JsonObject, ToolDef, ToolEffect, ToolOutput } from '../types.ts';

// `wrap` puts a shell command inside the OS sandbox when one is on.
export type ToolCtx = { cwd: string; signal: AbortSignal; wrap?: (command: string) => Promise<string> };

export type ToolSpec = ToolDef & {
  effect: ToolEffect;
  // Narrower effect for a given input, e.g. a bash command that only reads. Defaults to `effect`.
  effectOf?(input: JsonObject): ToolEffect;
  // The workspace path a write touches, so the policy can keep writes inside the working directory.
  pathOf?(input: JsonObject): string | undefined;
  replay: 'safe' | 'unsafe';
  run(input: JsonObject, ctx: ToolCtx): Promise<ToolOutput>;
};

// Tool definitions as the model sees them, in a fixed order (cache rule 1).
export function toolDefs(tools: ToolSpec[]): ToolDef[] {
  return tools.map(({ name, description, schema }) => ({ name, description, schema }));
}

export const effectOf = (spec: ToolSpec, input: JsonObject): ToolEffect => spec.effectOf?.(input) ?? spec.effect;

export const MAX_OUTPUT_CHARS = 30_000;

export function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max / 2);
  const tail = text.slice(-max / 2);
  return `${head}\n\n[... ${text.length - max} characters cut ...]\n\n${tail}`;
}
