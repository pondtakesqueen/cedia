import React from 'react';
import { Box, Text } from 'ink';
import { useCediaScreenReader } from './a11y.ts';
import { inkTheme } from './theme-tokens.ts';
import { cediaHome } from '../../core/config.ts';

export type PermissionDialogProps = {
  tool: string;
  input?: unknown;
  reason?: string;
  rule?: string;
};

export function toolLabel(tool: string): string {
  const raw = String(tool ?? '').trim();
  const key = raw.toLowerCase().replace(/[\s_-]+/g, '');
  switch (key) {
    case 'bash': return 'bash';
    case 'edit': return 'edit';
    case 'write':
    case 'filewrite':
      return 'write';
    case 'read':
    case 'fileread':
      return 'read';
    case 'grep': return 'grep';
    case 'glob': return 'glob';
    case 'webfetch':
      return 'web_fetch';
    case 'browser': return 'browser';
    case 'skill': return 'skill';
    case 'enterplanmode':
    case 'exitplanmode':
    case 'planmode':
    case 'plan':
      return 'plan mode';
    case 'filesystem':
    case 'fs':
      return 'filesystem';
    case 'sed': return 'sed';
    case 'fallback': return 'fallback';
    default: break;
  }
  const known = new Set([
    'bash', 'edit', 'write', 'read', 'grep', 'glob', 'web_fetch', 'browser',
    'ask_user', 'monitor', 'sleep', 'notebook_edit', 'notebookedit', 'tool_search',
    'toolsearch', 'open_thread', 'openthread', 'spawn', 'todo', 'schedule',
    'recall', 'threads', 'read_thread', 'message_thread', 'skill', 'webfetch',
  ]);
  const lower = raw.toLowerCase();
  return known.has(lower) ? lower : 'tool';
}

export type NoticeLine = { label: string; value: string };

export type NoticeBlock =
  | { kind: 'field'; label: string; value: string }
  | { kind: 'removed'; text: string }
  | { kind: 'added'; text: string }
  | { kind: 'preview'; text: string };

export const NOTICE_FIELDS: Record<string, readonly string[]> = {
  bash: ['command', 'timeout_ms'],
  edit: ['path', 'old_text', 'new_text', 'edits'],
  write: ['path', 'content', 'lines'],
  web_fetch: ['url', 'offset'],
  skill: ['name', 'args', 'file'],
  'plan mode': ['plan', 'action'],
  filesystem: ['op', 'path', 'destination'],
  sed: ['expression', 'path'],
};

export const DISMISS_NOTE = 'Esc or Enter closes this notice. The call was already denied.';

const CAP = 200;
const PREVIEW_LINES = 6;
const LINE_CAP = 120;

function cap(value: string): string {
  return value.length > CAP ? value.slice(0, CAP) : value;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pushField(blocks: NoticeBlock[], label: string, value: string | undefined) {
  if (value === undefined) return;
  blocks.push({ kind: 'field', label, value: cap(value) });
}

function clipLine(line: string): string {
  return line.length > LINE_CAP ? `${line.slice(0, LINE_CAP)}…` : line;
}

function pushPreview(blocks: NoticeBlock[], text: string) {
  const lines = text.split('\n');
  const shown = lines.slice(0, PREVIEW_LINES);
  for (const line of shown) blocks.push({ kind: 'preview', text: clipLine(line) });
  if (lines.length > PREVIEW_LINES) {
    blocks.push({ kind: 'preview', text: `… +${lines.length - PREVIEW_LINES} more lines` });
  }
}

function pushDiff(blocks: NoticeBlock[], oldText: string | undefined, newText: string | undefined) {
  if (oldText !== undefined) {
    for (const line of oldText.split('\n').slice(0, PREVIEW_LINES)) {
      blocks.push({ kind: 'removed', text: clipLine(line) });
    }
  }
  if (newText !== undefined) {
    for (const line of newText.split('\n').slice(0, PREVIEW_LINES)) {
      blocks.push({ kind: 'added', text: clipLine(line) });
    }
  }
}

export function noticeBlocks(tool: string, input: unknown): NoticeBlock[] {
  const label = toolLabel(tool);
  const fields = NOTICE_FIELDS[label];
  const record = asRecord(input);
  if (!fields || !record) {
    if (input == null) return [];
    if (typeof input === 'string') return [{ kind: 'field', label: 'input', value: cap(input) }];
    try { return [{ kind: 'field', label: 'input', value: cap(JSON.stringify(input)) }]; }
    catch { return [{ kind: 'field', label: 'input', value: cap(String(input)) }]; }
  }
  const blocks: NoticeBlock[] = [];
  if (label === 'bash') {
    pushField(blocks, 'command', textOf(record.command));
    if (typeof record.timeout_ms === 'number') pushField(blocks, 'timeout_ms', String(record.timeout_ms));
    return blocks;
  }
  if (label === 'edit') {
    pushField(blocks, 'path', textOf(record.path));
    const edits = Array.isArray(record.edits) ? record.edits : [];
    const first = edits[0] && typeof edits[0] === 'object' ? edits[0] as Record<string, unknown> : null;
    const oldText = textOf(first?.old_text) ?? textOf(record.old_text);
    const newText = textOf(first?.new_text) ?? textOf(record.new_text);
    pushDiff(blocks, oldText, newText);
    if (edits.length > 1) pushField(blocks, 'edits', String(edits.length));
    return blocks;
  }
  if (label === 'write') {
    pushField(blocks, 'path', textOf(record.path));
    if (typeof record.content === 'string') {
      const n = record.content.split('\n').length;
      pushField(blocks, 'lines', String(n));
      pushPreview(blocks, record.content);
    }
    return blocks;
  }
  if (label === 'web_fetch') {
    pushField(blocks, 'url', textOf(record.url));
    if (typeof record.offset === 'number') pushField(blocks, 'offset', String(record.offset));
    return blocks;
  }
  if (label === 'skill') {
    const name = textOf(record.name) ?? textOf(record.skill);
    pushField(blocks, 'name', name);
    pushField(blocks, 'args', textOf(record.args) ?? textOf(record.arguments));
    if (typeof record.file === 'string') pushField(blocks, 'file', record.file);
    return blocks;
  }
  if (label === 'plan mode') {
    pushField(blocks, 'action', textOf(record.action) ?? textOf(record.mode));
    const plan = textOf(record.plan) ?? textOf(record.prompt) ?? textOf(record.message);
    if (plan) pushPreview(blocks, plan);
    return blocks;
  }
  if (label === 'filesystem') {
    pushField(blocks, 'op', textOf(record.op) ?? textOf(record.operation) ?? textOf(record.command));
    pushField(blocks, 'path', textOf(record.path) ?? textOf(record.src) ?? textOf(record.source));
    pushField(blocks, 'destination', textOf(record.destination) ?? textOf(record.dest) ?? textOf(record.to));
    return blocks;
  }
  if (label === 'sed') {
    pushField(blocks, 'expression', textOf(record.expression) ?? textOf(record.expr) ?? textOf(record.command));
    pushField(blocks, 'path', textOf(record.path) ?? textOf(record.file));
    return blocks;
  }
  const name = textOf(record.name) ?? textOf(record.skill);
  pushField(blocks, 'name', name);
  if (typeof record.file === 'string') pushField(blocks, 'file', record.file);
  return blocks;
}

/** Field rows only; diff/preview layouts live in `noticeBlocks`. */
export function noticeLines(tool: string, input: unknown): NoticeLine[] {
  return noticeBlocks(tool, input)
    .filter((b): b is Extract<NoticeBlock, { kind: 'field' }> => b.kind === 'field')
    .map((b) => ({ label: b.label, value: b.value }));
}

function renderBlock(
  block: NoticeBlock,
  i: number,
  screenReader: boolean,
  T: ReturnType<typeof inkTheme>['tokens'],
): React.ReactNode {
  if (block.kind === 'field') {
    return React.createElement(Text, { key: `f-${block.label}-${i}` }, `${block.label}: ${block.value}`);
  }
  if (block.kind === 'removed') {
    return React.createElement(
      Text,
      { key: `r-${i}`, color: screenReader ? undefined : T.diffRemoved },
      `- ${block.text}`,
    );
  }
  if (block.kind === 'added') {
    return React.createElement(
      Text,
      { key: `a-${i}`, color: screenReader ? undefined : T.diffAdded },
      `+ ${block.text}`,
    );
  }
  return React.createElement(
    Text,
    { key: `p-${i}`, dimColor: !screenReader, color: screenReader ? undefined : T.code },
    block.text,
  );
}

export function PermissionDialog(props: PermissionDialogProps): React.ReactElement {
  const { tool, input, reason, rule } = props;
  const screenReader = useCediaScreenReader();
  const label = toolLabel(tool);
  const T = inkTheme(cediaHome()).tokens;
  const blocks = noticeBlocks(tool, input);
  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: screenReader ? undefined : 'single', borderColor: screenReader ? undefined : T.borderActive, paddingX: 1 },
    React.createElement(Text, { bold: !screenReader, color: screenReader ? undefined : T.accent }, `${label} denied`),
    ...blocks.map((block, i) => renderBlock(block, i, screenReader, T)),
    reason ? React.createElement(Text, { color: screenReader ? undefined : T.error }, reason) : null,
    rule ? React.createElement(Text, { dimColor: !screenReader }, `rule: ${rule}`) : null,
    React.createElement(Text, { dimColor: !screenReader }, DISMISS_NOTE),
  );
}
