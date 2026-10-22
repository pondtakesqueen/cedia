import type { JsonObject, ToolDef, ToolEffect, ToolOutput } from '../types.ts';

// `wrap` puts a shell command inside the OS sandbox when one is on. `spill` writes a whole output too long for
// the result to a file (redacted like a result) and returns its path, or undefined when it could not.
// `diagnose` gives a file's errors as a language server sees them (core/lsp/diagnose.ts), when one covers it.
export type ToolCtx = {
  cwd: string;
  signal: AbortSignal;
  wrap?: (command: string) => Promise<string>;
  spill?: (text: string) => string | undefined;
  diagnose?: (file: string, signal?: AbortSignal) => Promise<string | undefined>;
};

export type ToolSpec = ToolDef & {
  effect: ToolEffect;
  // Narrower effect for a given input, e.g. a bash command that only reads. Defaults to `effect`.
  effectOf?(input: JsonObject): ToolEffect;
  // The path a call reads or writes, so the policy can keep writes inside the working directory and reads out of
  // credential stores.
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

// An output too long for a result, when the whole of it is in a file: its start and end, and where the rest is,
// within the same budget as `clip`.
export function preview(text: string, path: string, max = MAX_OUTPUT_CHARS): string {
  const lines = text.split('\n').length;
  // The note's own length depends on the count it states; sized for the longest count, it always fits.
  const note = (hidden: number) => `[... ${hidden} characters not shown. The whole output (${text.length} characters, ${lines} lines) is in ${path}: grep it, or read it with offset and limit ...]`;
  const side = Math.floor((max - note(text.length).length - 4) / 2);
  return `${text.slice(0, side)}\n\n${note(text.length - 2 * side)}\n\n${text.slice(-side)}`;
}
