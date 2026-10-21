// A least-recently-used cache whose entries also expire.
//
// new LRU(capacity, ttlMs, now = Date.now):
// - get(key): the value, or undefined when missing or expired. A hit makes the entry the most recently used.
//   An expired entry is removed when it is found, with onEvict(key, value, 'expired').
// - set(key, value): stores it as the most recently used, with a fresh ttl. When that takes the cache over
//   capacity, the least recently used entry is removed with onEvict(key, value, 'capacity'). Expired entries
//   are removed first (reason 'expired'), and only if the cache is still over capacity is a live one evicted.
// - delete(key): true if a live entry was removed (onEvict reason 'delete'); an expired one is removed with
//   reason 'expired' and delete returns false.
// - size: the number of live (unexpired) entries.
// - keys(): live keys, most recently used first.
// An entry set at time t expires at t + ttlMs: it is live while now() < t + ttlMs.
export type EvictReason = 'capacity' | 'expired' | 'delete';

export class LRU<K, V> {
  onEvict?: (key: K, value: V, reason: EvictReason) => void;

  constructor(capacity: number, ttlMs: number, now: () => number = Date.now) {
    throw new Error('not implemented');
  }

  get(key: K): V | undefined {
    throw new Error('not implemented');
  }

  set(key: K, value: V): void {
    throw new Error('not implemented');
  }

  delete(key: K): boolean {
    throw new Error('not implemented');
  }

  get size(): number {
    throw new Error('not implemented');
  }

  keys(): K[] {
    throw new Error('not implemented');
  }
}
