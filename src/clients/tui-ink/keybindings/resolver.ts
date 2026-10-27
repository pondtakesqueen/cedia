import type { Binding, Context } from './types.ts';

export type OverlayState = {
  permissionNotice: boolean;
  picker: boolean;
  settings: boolean;
  messageSelector: boolean;
  historySearch: boolean;
  transcriptSearch: boolean;
  autocomplete: boolean;
};

export const IDLE_OVERLAY: OverlayState = {
  permissionNotice: false,
  picker: false,
  settings: false,
  messageSelector: false,
  historySearch: false,
  transcriptSearch: false,
  autocomplete: false,
};

export const ORDER = [
  ['permissionNotice', 'Confirmation'],
  ['picker', 'Select'],
  ['settings', 'Settings'],
  ['messageSelector', 'MessageSelector'],
  ['historySearch', 'HistorySearch'],
  ['transcriptSearch', 'Transcript'],
  ['autocomplete', 'Autocomplete'],
] as const satisfies readonly (readonly [keyof OverlayState, Context])[];

type OrderedKey = (typeof ORDER)[number][0];
const _orderCoversOverlayState: [Exclude<keyof OverlayState, OrderedKey>] extends [never] ? true : never = true;

export type LiveContext = (typeof ORDER)[number][1] | 'Chat';

export function activeContext(state: OverlayState): LiveContext {
  void _orderCoversOverlayState;
  for (const [field, ctx] of ORDER) {
    if (state[field]) return ctx;
  }
  return 'Chat';
}

export type VimGate = { captured: boolean; suppressSubmit: boolean };

export function vimInputGate(ctx: LiveContext, trustOpen: boolean): VimGate {
  if (trustOpen) return { captured: true, suppressSubmit: false };
  if (ctx === 'Autocomplete') return { captured: false, suppressSubmit: true };
  if (ctx === 'Chat') return { captured: false, suppressSubmit: false };
  return { captured: true, suppressSubmit: false };
}

export const DEFAULT_BINDINGS: Binding[] = [
  { key: 'ctrl+c', command: 'cancel', context: 'Global' },
  { key: 'enter', command: 'submit', context: 'Chat' },
  { key: 'up', command: 'historyUp', context: 'Chat' },
  { key: 'down', command: 'historyDown', context: 'Chat' },
  { key: 'tab', command: 'autocomplete', context: 'Chat' },
  { key: 'escape', command: 'cancel', context: 'Autocomplete' },
  { key: 'ctrl+r', command: 'historySearch', context: 'Chat' },
];

export function resolveBindings(overrides: Binding[]): Binding[] {
  const map = new Map<string, Binding>();
  for (const b of DEFAULT_BINDINGS) map.set(`${b.context ?? '*'}:${b.key}`, b);
  // overrides replace by context+key
  for (const b of overrides) map.set(`${b.context ?? '*'}:${b.key}`, b);
  return [...map.values()];
}

export function findCommand(bindings: Binding[], key: string, context: Context): string | undefined {
  // context-specific first, then Global
  const specific = bindings.find((b) => b.key === key && b.context === context);
  if (specific) return specific.command;
  const global = bindings.find((b) => b.key === key && (b.context === 'Global' || !b.context));
  return global?.command;
}
