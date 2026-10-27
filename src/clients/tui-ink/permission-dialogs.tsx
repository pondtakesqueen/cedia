import React from 'react';
import { Box, Text, useIsScreenReaderEnabled } from 'ink';
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

export const NOTICE_FIELDS: Record<string, readonly string[]> = {
  bash: ['command', 'timeout_ms'],
  edit: ['path', 'old_text', 'new_text', 'edits'],
  write: ['path', 'content'],
  web_fetch: ['url', 'offset'],
  skill: ['name', 'file'],
};

export const DISMISS_NOTE = 'Esc or Enter closes this notice. The call was already denied.';

const CAP = 200;

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

function pushLine(lines: NoticeLine[], label: string, value: string | undefined) {
  if (value === undefined) return;
  lines.push({ label, value: cap(value) });
}

export function noticeLines(tool: string, input: unknown): NoticeLine[] {
  const label = toolLabel(tool);
  const fields = NOTICE_FIELDS[label];
  const record = asRecord(input);
  if (!fields || !record) {
    if (input == null) return [];
    if (typeof input === 'string') return [{ label: 'input', value: cap(input) }];
    try { return [{ label: 'input', value: cap(JSON.stringify(input)) }]; }
    catch { return [{ label: 'input', value: cap(String(input)) }]; }
  }
  const lines: NoticeLine[] = [];
  if (label === 'bash') {
    pushLine(lines, 'command', textOf(record.command));
    if (typeof record.timeout_ms === 'number') pushLine(lines, 'timeout_ms', String(record.timeout_ms));
    return lines;
  }
  if (label === 'edit') {
    pushLine(lines, 'path', textOf(record.path));
    const edits = Array.isArray(record.edits) ? record.edits : [];
    const first = edits[0] && typeof edits[0] === 'object' ? edits[0] as Record<string, unknown> : null;
    pushLine(lines, 'old_text', textOf(first?.old_text) ?? textOf(record.old_text));
    pushLine(lines, 'new_text', textOf(first?.new_text) ?? textOf(record.new_text));
    if (edits.length > 1) pushLine(lines, 'edits', String(edits.length));
    return lines;
  }
  if (label === 'write') {
    pushLine(lines, 'path', textOf(record.path));
    if (typeof record.content === 'string') {
      pushLine(lines, 'content', `${record.content.length} chars, ${record.content.slice(0, 80)}`);
    }
    return lines;
  }
  if (label === 'web_fetch') {
    pushLine(lines, 'url', textOf(record.url));
    if (typeof record.offset === 'number') pushLine(lines, 'offset', String(record.offset));
    return lines;
  }
  const name = textOf(record.name) ?? textOf(record.skill);
  pushLine(lines, 'name', name);
  if (typeof record.file === 'string') pushLine(lines, 'file', record.file);
  return lines;
}

export function PermissionDialog(props: PermissionDialogProps): React.ReactElement {
  const { tool, input, reason, rule } = props;
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';
  const label = toolLabel(tool);
  const T = inkTheme(cediaHome()).tokens;
  const lines = noticeLines(tool, input);
  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: screenReader ? undefined : 'single', borderColor: screenReader ? undefined : T.borderActive, paddingX: 1 },
    React.createElement(Text, { bold: !screenReader, color: screenReader ? undefined : T.accent }, `${label} denied`),
    ...lines.map((line, i) => React.createElement(Text, { key: `${line.label}-${i}` }, `${line.label}: ${line.value}`)),
    reason ? React.createElement(Text, { color: screenReader ? undefined : T.error }, reason) : null,
    rule ? React.createElement(Text, { dimColor: !screenReader }, `rule: ${rule}`) : null,
    React.createElement(Text, { dimColor: !screenReader }, DISMISS_NOTE),
  );
}
