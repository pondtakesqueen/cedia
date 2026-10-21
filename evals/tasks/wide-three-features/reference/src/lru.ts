export type EvictReason = 'capacity' | 'expired' | 'delete';

export class LRU<K, V> {
  onEvict?: (key: K, value: V, reason: EvictReason) => void;
  // Map keeps insertion order: the first entry is the least recently used.
  private entries = new Map<K, { value: V; expires: number }>();

  constructor(
    private capacity: number,
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  private live(e: { expires: number }) {
    return this.now() < e.expires;
  }

  private drop(key: K, reason: EvictReason) {
    const e = this.entries.get(key)!;
    this.entries.delete(key);
    this.onEvict?.(key, e.value, reason);
  }

  get(key: K): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (!this.live(e)) {
      this.drop(key, 'expired');
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    if (this.entries.size <= this.capacity) return;
    for (const [k, e] of [...this.entries]) if (!this.live(e)) this.drop(k, 'expired');
    while (this.entries.size > this.capacity) this.drop(this.entries.keys().next().value as K, 'capacity');
  }

  delete(key: K): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    if (!this.live(e)) {
      this.drop(key, 'expired');
      return false;
    }
    this.drop(key, 'delete');
    return true;
  }

  get size(): number {
    return [...this.entries.values()].filter((e) => this.live(e)).length;
  }

  keys(): K[] {
    return [...this.entries].filter(([, e]) => this.live(e)).map(([k]) => k).reverse();
  }
}
