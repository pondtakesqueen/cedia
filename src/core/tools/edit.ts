import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { JsonObject } from '../types.ts';
import type { ToolSpec } from './registry.ts';

export type TextEdit = { old_text: string; new_text: string; replace_all?: boolean };
type Tier = 'exact' | 'trailing-space' | 'indentation';
export type Applied = { from: number; to: number; tier: Tier; count: number };

// The edits a call asked for. Besides the schema's `edits` array, it takes the two shapes models send most
// often by mistake (measured: 179 of 418 Haiku 5.5 edit calls in the eval logs): old_text and new_text at the
// top level, and `edits` as a string, either JSON or a broken `[{"old_text">…` with new_text at the top level.
export function editsOf(input: JsonObject): TextEdit[] | { error: string } {
  const one = (old: unknown, next: unknown): TextEdit[] | undefined =>
    typeof old === 'string' && typeof next === 'string' ? [{ old_text: old, new_text: next, ...(input.replace_all === true ? { replace_all: true } : {}) }] : undefined;
  let raw = input.edits;
  if (raw === undefined) return one(input.old_text, input.new_text) ?? { error: 'edits is required: an array of {old_text, new_text}' };
  if (typeof raw === 'string') {
    const broken = /^\[\{"old_text">([\s\S]*)$/.exec(raw);
    if (broken) return one(broken[1], input.new_text) ?? { error: 'edits must be an array of {old_text, new_text} objects, not a string' };
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: 'edits must be an array of {old_text, new_text} objects, not a string' };
    }
  }
  if (!Array.isArray(raw)) return { error: 'edits must be an array of {old_text, new_text} objects' };
  if (!raw.length) return { error: 'edits is empty' };
  const bad = raw.findIndex((e) => !e || typeof e !== 'object' || typeof (e as TextEdit).old_text !== 'string' || typeof (e as TextEdit).new_text !== 'string');
  if (bad >= 0) return { error: `edits[${bad}] needs old_text and new_text strings` };
  return raw as TextEdit[];
}

// The kind of repair a call needed, for the log: which wrong shape it came in.
export function editRepair(input: JsonObject): { input: JsonObject; repairs: string[] } | undefined {
  const raw = input.edits;
  const kind =
    raw === undefined && typeof input.old_text === 'string' ? 'top-level old_text/new_text' : typeof raw === 'string' ? (/^\[\{"old_text">/.test(raw) ? 'broken edits string' : 'edits as a JSON string') : undefined;
  if (!kind) return undefined;
  const edits = editsOf(input);
  if ('error' in edits) return undefined; // the tool's own error names the shape
  return { input: { ...(input.path !== undefined ? { path: input.path } : {}), edits }, repairs: [kind] };
}

const fullPath = (input: JsonObject, cwd: string) => {
  const path = String(input.path ?? '');
  return isAbsolute(path) ? path : resolve(cwd, path);
};

// Tiered matching: exact text first, then whole lines ignoring trailing spaces, then ignoring indentation
// (re-indenting new_text to the file). A tier only applies when it finds exactly one place.
export function applyEdit(content: string, edit: TextEdit): { content: string; applied: Applied } | { error: string } {
  const { old_text: oldText, new_text: newText } = edit;
  if (!oldText) return { error: 'old_text is empty; use write to create a file' };
  if (oldText === newText) return { error: 'old_text and new_text are the same' };

  const first = content.indexOf(oldText);
  if (first >= 0) {
    const count = content.split(oldText).length - 1;
    if (count > 1 && !edit.replace_all)
      return { error: `old_text matches ${count} places (first at line ${lineOf(content, first)}); add surrounding lines or set replace_all` };
    const next = edit.replace_all ? content.split(oldText).join(newText) : content.slice(0, first) + newText + content.slice(first + oldText.length);
    return { content: next, applied: { from: lineOf(content, first), to: lineOf(content, first + oldText.length - 1), tier: 'exact', count } };
  }

  const lines = content.split('\n');
  const want = trimLastNewline(oldText).split('\n');
  for (const tier of ['trailing-space', 'indentation'] as const) {
    const norm = tier === 'trailing-space' ? (l: string) => l.trimEnd() : (l: string) => l.trim();
    const target = want.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + target.length <= lines.length; i++) {
      if (target.every((t, k) => norm(lines[i + k]!) === t)) hits.push(i);
    }
    if (hits.length > 1) return { error: `old_text matches ${hits.length} places when ${tier === 'trailing-space' ? 'trailing spaces are' : 'indentation is'} ignored (lines ${hits.map((h) => h + 1).join(', ')}); add surrounding lines` };
    if (hits.length === 1) {
      const at = hits[0]!;
      let repl = trimLastNewline(newText).split('\n');
      if (tier === 'indentation') repl = reindent(repl, indentOf(want), indentOf(lines.slice(at, at + want.length)));
      const next = [...lines.slice(0, at), ...(newText === '' ? [] : repl), ...lines.slice(at + want.length)].join('\n');
      return { content: next, applied: { from: at + 1, to: at + want.length, tier, count: 1 } };
    }
  }
  return { error: `old_text not found${hint(lines, want)}; read the file again and copy the text exactly` };
}

const lineOf = (s: string, index: number) => s.slice(0, index).split('\n').length;
const trimLastNewline = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s);
const indentOf = (ls: string[]) => /^\s*/.exec(ls.find((l) => l.trim()) ?? '')![0];

function reindent(lines: string[], from: string, to: string): string[] {
  return lines.map((l) => (l.trim() === '' ? l : to + (l.startsWith(from) ? l.slice(from.length) : l.trimStart())));
}

function hint(lines: string[], want: string[]): string {
  const key = want.find((l) => l.trim())?.trim();
  if (!key) return '';
  const at = lines.flatMap((l, i) => (l.includes(key) ? [i + 1] : [])).slice(0, 5);
  return at.length ? ` (its first line appears at line ${at.join(', ')})` : '';
}

export const editTool: ToolSpec = {
  name: 'edit',
  description:
    'Replace text in an existing file. Each edit replaces old_text with new_text; old_text must match one place unless replace_all is set. Edits apply in order and all or none. Copy old_text from a fresh read; small whitespace differences are tolerated.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old_text: { type: 'string', description: 'Text to find, including enough lines to be unique' },
            new_text: { type: 'string', description: 'Replacement text' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence' },
          },
          required: ['old_text', 'new_text'],
          additionalProperties: false,
        },
      },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
  },
  effect: 'write_workspace',
  replay: 'unsafe',
  pathOf: (input) => (typeof input.path === 'string' ? input.path : undefined),
  repair: editRepair,
  async run(input, ctx) {
    const path = String(input.path ?? '');
    if (!path) return { text: 'path is required', isError: true };
    const edits = editsOf(input);
    if ('error' in edits) return { text: edits.error, isError: true };
    const full = fullPath(input, ctx.cwd);
    let raw: string;
    try {
      if (statSync(full).isDirectory()) return { text: `${path} is a directory`, isError: true };
      raw = readFileSync(full, 'utf8');
    } catch (e) {
      return { text: `cannot read ${path}: ${(e as Error).message}`, isError: true };
    }
    const crlf = raw.includes('\r\n');
    let content = crlf ? raw.replace(/\r\n/g, '\n') : raw;
    const notes: string[] = [];
    for (const [i, e] of edits.entries()) {
      const r = applyEdit(content, { old_text: String(e.old_text ?? ''), new_text: String(e.new_text ?? ''), replace_all: e.replace_all === true });
      if ('error' in r) return { text: `edit ${i + 1} of ${edits.length}: ${r.error}. No edits were applied.`, isError: true };
      content = r.content;
      const { from, to, tier, count } = r.applied;
      notes.push(`edit ${i + 1}: lines ${from}-${to}${count > 1 ? ` and ${count - 1} more` : ''}${tier === 'exact' ? '' : ` (matched ignoring ${tier === 'trailing-space' ? 'trailing spaces' : 'indentation'})`}`);
    }
    writeFileSync(full, crlf ? content.replace(/\n/g, '\r\n') : content);
    return { text: `edited ${path}\n${notes.join('\n')}`, isError: false };
  },
};

export const writeTool: ToolSpec = {
  name: 'write',
  description: 'Create a file or replace its whole content. Prefer edit for changes to an existing file.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      content: { type: 'string', description: 'The full file content' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  effect: 'write_workspace',
  replay: 'unsafe',
  pathOf: (input) => (typeof input.path === 'string' ? input.path : undefined),
  async run(input, ctx) {
    const path = String(input.path ?? '');
    if (!path) return { text: 'path is required', isError: true };
    if (typeof input.content !== 'string') return { text: 'content must be a string', isError: true };
    const full = fullPath(input, ctx.cwd);
    const existed = existsSync(full);
    try {
      if (existed && statSync(full).isDirectory()) return { text: `${path} is a directory`, isError: true };
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, input.content);
    } catch (e) {
      return { text: `cannot write ${path}: ${(e as Error).message}`, isError: true };
    }
    const lines = input.content ? trimLastNewline(input.content).split('\n').length : 0;
    return { text: `${existed ? 'replaced' : 'created'} ${path} (${lines} lines)`, isError: false };
  },
};
