import type { Binding, Context } from './types.ts';
import { CHORD_TIMEOUT_MS } from './types.ts';

export type ChordSpec = { keys: readonly string[]; command: string };

export type ChordMatch =
  | { status: 'exact'; command: string }
  | { status: 'prefix' }
  | { status: 'none' };

export function parseChordKey(key: string): string[] {
  const raw = String(key ?? '').trim();
  if (!raw) return [];
  if (raw.includes(',')) return raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (/\s/.test(raw)) return raw.split(/\s+/).filter(Boolean);
  return [raw];
}

export function chordsFromBindings(bindings: readonly Binding[], context: Context): ChordSpec[] {
  const out: ChordSpec[] = [];
  for (const b of bindings) {
    if (b.context && b.context !== context && b.context !== 'Global') continue;
    const keys = parseChordKey(b.key);
    if (keys.length < 2) continue;
    out.push({ keys, command: b.command });
  }
  return out;
}

export function matchChord(buffer: readonly string[], chords: readonly ChordSpec[]): ChordMatch {
  if (buffer.length === 0) return { status: 'none' };
  let prefix = false;
  for (const chord of chords) {
    if (chord.keys.length < buffer.length) continue;
    let ok = true;
    for (let i = 0; i < buffer.length; i++) {
      if (chord.keys[i] !== buffer[i]) { ok = false; break; }
    }
    if (!ok) continue;
    if (chord.keys.length === buffer.length) return { status: 'exact', command: chord.command };
    prefix = true;
  }
  return prefix ? { status: 'prefix' } : { status: 'none' };
}

export class ChordInterceptor {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private match: (keys: readonly string[]) => ChordMatch,
    private onExact: (command: string) => void = () => {},
    private timeoutMs = CHORD_TIMEOUT_MS,
  ) {}

  push(key: string): 'handled' | 'pending' | 'none' {
    const tryMatch = (buf: string[]): 'handled' | 'pending' | 'none' => {
      const result = this.match(buf);
      if (result.status === 'exact') {
        this.buffer = [];
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.onExact(result.command);
        return 'handled';
      }
      if (result.status === 'prefix') {
        this.buffer = buf;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.buffer = []; this.timer = null; }, this.timeoutMs);
        return 'pending';
      }
      return 'none';
    };

    const next = [...this.buffer, key];
    const first = tryMatch(next);
    if (first !== 'none') return first;
    if (next.length > 1) {
      const retry = tryMatch([key]);
      if (retry !== 'none') return retry;
    }
    this.buffer = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return 'none';
  }

  reset() {
    this.buffer = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
