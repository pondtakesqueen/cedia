import { CHORD_TIMEOUT_MS } from './types.ts';

export class ChordInterceptor {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private onChord: (keys: string[]) => boolean, private timeoutMs = CHORD_TIMEOUT_MS) {}

  push(key: string): 'handled' | 'pending' | 'none' {
    this.buffer.push(key);
    if (this.timer) clearTimeout(this.timer);
    // If a chord matches immediately, fire.
    if (this.onChord([...this.buffer])) {
      this.buffer = [];
      return 'handled';
    }
    // Wait for more keys.
    this.timer = setTimeout(() => { this.buffer = []; }, this.timeoutMs);
    return 'pending';
  }

  reset() { this.buffer = []; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}
