export interface MemoOptions {
  ttlMs: number;
  max: number;
  // The clock, for tests.
  now?: () => number;
}

export interface Memo<K, V> {
  (key: K): Promise<V>;
  invalidate(key: K): void;
  clear(): void;
  readonly size: number;
}

/**
 * Caches `fn`'s result per key.
 * - Calls for a key while a call for it is in flight share that call's promise, so `fn` runs once.
 * - A result is kept for `ttlMs` from when its promise settled; the first call after that runs `fn` again.
 * - A rejection is not kept: every caller waiting on that call gets it, and the next call runs `fn` again.
 * - At most `max` keys are kept, in flight or settled. Keeping one more drops the least recently used key, where
 *   a key is used when it is added and each time a call is answered from the cache.
 * - `invalidate(key)` forgets the key at once. A call after it runs `fn` again even while an earlier call is still
 *   in flight, and that earlier call's result is not kept when it settles (the callers already waiting on it
 *   still get it). A key that was dropped to stay under `max` is forgotten the same way.
 * - `clear()` is `invalidate` for every key. `size` is the number of keys kept.
 */
export function memo<K, V>(fn: (key: K) => Promise<V>, opts: MemoOptions): Memo<K, V> {
  if (!(opts.ttlMs > 0) || !Number.isInteger(opts.max) || opts.max < 1) throw new RangeError("ttlMs must be above 0 and max a whole number from 1");
  const now = opts.now ?? Date.now;
  // In insertion order, least recently used first. A key in flight does not expire.
  const cache = new Map<K, { promise: Promise<V>; expires: number }>();
  const call = ((key: K) => {
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.promise;
    }
    cache.delete(key);
    while (cache.size >= opts.max) cache.delete(cache.keys().next().value as K);
    const entry = { promise: fn(key), expires: Infinity };
    cache.set(key, entry);
    // Only the entry still under the key is changed: one invalidated or dropped since is gone for good.
    entry.promise.then(
      () => {
        if (cache.get(key) === entry) entry.expires = now() + opts.ttlMs;
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key);
      },
    );
    return entry.promise;
  }) as Memo<K, V>;
  call.invalidate = (key) => void cache.delete(key);
  call.clear = () => cache.clear();
  Object.defineProperty(call, "size", { get: () => cache.size });
  return call;
}
