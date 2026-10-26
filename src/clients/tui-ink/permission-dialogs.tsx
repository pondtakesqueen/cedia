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

function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 200);
  try {
    const o = input as Record<string, unknown>;
    const pick =
      o.command ?? o.path ?? o.file_path ?? o.filePath ?? o.url ?? o.skill ?? o.old_string ?? o.query ?? o.pattern;
    if (pick != null) {
      const s = String(pick);
      if (o.new_string != null && o.old_string != null) {
        return `${String(o.old_string).slice(0, 80)} → ${String(o.new_string).slice(0, 80)}`.slice(0, 200);
      }
      return s.slice(0, 200);
    }
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return String(input).slice(0, 200);
  }
}

export function PermissionDialog(props: PermissionDialogProps): React.ReactElement {
  const { tool, input, reason, rule } = props;
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';
  const label = toolLabel(tool);
  const T = inkTheme(cediaHome()).tokens;
  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: screenReader ? undefined : 'single', borderColor: screenReader ? undefined : T.borderActive, paddingX: 1 },
    React.createElement(Text, { bold: !screenReader, color: screenReader ? undefined : T.accent }, `${label} permission`),
    React.createElement(Text, {}, `tool: ${tool || label}`),
    React.createElement(Text, { dimColor: !screenReader }, `input: ${previewInput(input)}`),
    reason ? React.createElement(Text, { color: screenReader ? undefined : T.error }, `denied: ${reason}`) : null,
    rule ? React.createElement(Text, { dimColor: !screenReader }, `rule: ${rule}`) : null,
    React.createElement(Text, { dimColor: !screenReader }, '[Allow] [Deny]'),
  );
}

// Specialized per-tool components (informational overlays). Each surfaces the
// field that matters most for its tool, plus the shared input preview.
function detailFor(kind: string, input: unknown): string | null {
  if (input == null || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const str = (v: unknown) => (v == null ? null : String(v).slice(0, 120));
  switch (kind) {
    case 'filewrite': {
      const p = str(o.path ?? o.file_path ?? o.filePath);
      return p ? `file: ${p}` : null;
    }
    case 'skill': {
      const s = str(o.skill ?? o.name);
      return s ? `skill: ${s}` : null;
    }
    case 'planmode': {
      const m = str(o.mode ?? o.plan);
      return m ? `mode: ${m}` : null;
    }
    case 'filesystem': {
      const p = str(o.path ?? o.dir ?? o.directory);
      return p ? `path: ${p}` : null;
    }
    case 'sed': {
      const p = str(o.pattern ?? o.expression ?? o.script);
      return p ? `pattern: ${p}` : null;
    }
    default:
      return null;
  }
}

function Specialized(props: PermissionDialogProps & { kind: string }): React.ReactElement {
  const { kind, tool, input, reason, rule } = props;
  const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';
  const label = toolLabel(tool);
  const T = inkTheme(cediaHome()).tokens;
  const detail = detailFor(kind, input);
  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: screenReader ? undefined : 'single', borderColor: screenReader ? undefined : T.borderActive, paddingX: 1 },
    React.createElement(Text, { bold: !screenReader, color: screenReader ? undefined : T.accent }, `${label} permission`),
    React.createElement(Text, {}, `tool: ${tool || label}`),
    detail ? React.createElement(Text, {}, detail) : null,
    React.createElement(Text, { dimColor: !screenReader }, `input: ${previewInput(input)}`),
    reason ? React.createElement(Text, { color: screenReader ? undefined : T.error }, `denied: ${reason}`) : null,
    rule ? React.createElement(Text, { dimColor: !screenReader }, `rule: ${rule}`) : null,
    React.createElement(Text, { dimColor: !screenReader }, '[Allow] [Deny]'),
  );
}

export function FileWritePermissionDialog(props: PermissionDialogProps): React.ReactElement {
  return React.createElement(Specialized, { kind: 'filewrite', ...props });
}
export function SkillPermissionDialog(props: PermissionDialogProps): React.ReactElement {
  return React.createElement(Specialized, { kind: 'skill', ...props });
}
export function EnterPlanModePermissionDialog(props: PermissionDialogProps): React.ReactElement {
  return React.createElement(Specialized, { kind: 'planmode', ...props });
}
export function ExitPlanModePermissionDialog(props: PermissionDialogProps): React.ReactElement {
  return React.createElement(Specialized, { kind: 'planmode', ...props });
}
export function FilesystemPermissionDialog(props: PermissionDialogProps): React.ReactElement {
  return React.createElement(Specialized, { kind: 'filesystem', ...props });
}
export function SedPermissionDialog(props: PermissionDialogProps): React.ReactElement {
  return React.createElement(Specialized, { kind: 'sed', ...props });
}
export function FallbackPermissionDialog(props: PermissionDialogProps): React.ReactElement {
  return React.createElement(PermissionDialog, props);
}

// Aliases matching common naming.
export const FileWriteDialog = FileWritePermissionDialog;
export const SkillDialog = SkillPermissionDialog;
export const EnterPlanModeDialog = EnterPlanModePermissionDialog;
export const ExitPlanModeDialog = ExitPlanModePermissionDialog;
export const FilesystemDialog = FilesystemPermissionDialog;
export const SedDialog = SedPermissionDialog;
export const FallbackDialog = FallbackPermissionDialog;

export function permissionDialogFor(tool: string): (props: PermissionDialogProps) => React.ReactElement {
  const key = String(tool ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  switch (key) {
    case 'write':
    case 'filewrite':
      return FileWritePermissionDialog;
    case 'skill':
      return SkillPermissionDialog;
    case 'enterplanmode':
      return EnterPlanModePermissionDialog;
    case 'exitplanmode':
      return ExitPlanModePermissionDialog;
    case 'filesystem':
    case 'fs':
      return FilesystemPermissionDialog;
    case 'sed':
      return SedPermissionDialog;
    case 'fallback':
      return FallbackPermissionDialog;
    default:
      return PermissionDialog;
  }
}

export const permissionDialogs = {
  FileWrite: FileWritePermissionDialog,
  Skill: SkillPermissionDialog,
  EnterPlanMode: EnterPlanModePermissionDialog,
  ExitPlanMode: ExitPlanModePermissionDialog,
  Filesystem: FilesystemPermissionDialog,
  Sed: SedPermissionDialog,
  Fallback: FallbackPermissionDialog,
};
