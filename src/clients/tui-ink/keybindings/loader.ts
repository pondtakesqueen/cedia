import { existsSync, readFileSync, watchFile } from 'node:fs';
import { join } from 'node:path';
import { cediaHome } from '../../../core/config.ts';
import type { Binding, KeybindingsFile } from './types.ts';

export const keybindingsPath = (home = cediaHome()) => join(home, 'keybindings.json');

export function loadKeybindings(home = cediaHome()): Binding[] {
  const p = keybindingsPath(home);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as KeybindingsFile;
    if (!Array.isArray(raw.bindings)) return [];
    return raw.bindings.filter((b) => b && typeof b.key === 'string' && typeof b.command === 'string');
  } catch {
    return [];
  }
}

export function watchKeybindings(home: string, cb: (b: Binding[]) => void): () => void {
  const p = keybindingsPath(home);
  const handler = () => cb(loadKeybindings(home));
  watchFile(p, { interval: 500 }, handler);
  return () => {};
}
