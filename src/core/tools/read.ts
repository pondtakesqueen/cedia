import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { clip, type ToolSpec } from './registry.ts';

const MAX_LINES = 2000;

export const readTool: ToolSpec = {
  name: 'read',
  description:
    'Read a text file. Returns numbered lines. Use offset and limit for large files (default: first 2000 lines).',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      offset: { type: 'integer', description: '1-based line to start from' },
      limit: { type: 'integer', description: 'Number of lines to read' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  effect: 'read',
  replay: 'safe',
  async run(input, ctx) {
    const path = String(input.path ?? '');
    if (!path) return { text: 'path is required', isError: true };
    const full = isAbsolute(path) ? path : resolve(ctx.cwd, path);
    let content: string;
    try {
      if (statSync(full).isDirectory()) return { text: `${path} is a directory`, isError: true };
      content = readFileSync(full, 'utf8');
    } catch (e) {
      return { text: `cannot read ${path}: ${(e as Error).message}`, isError: true };
    }
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const start = Math.max(1, Number(input.offset ?? 1));
    const limit = Math.max(1, Math.min(Number(input.limit ?? MAX_LINES), MAX_LINES));
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join('\n');
    const more = start - 1 + slice.length < lines.length ? `\n[${lines.length - (start - 1 + slice.length)} more lines; use offset]` : '';
    return { text: clip(body + more) || '(empty file)', isError: false };
  },
};
