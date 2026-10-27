import type { Binding, Context } from './types.ts';

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
