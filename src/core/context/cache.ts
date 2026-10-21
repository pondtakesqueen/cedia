import type { EventOf, SessionEvent } from '../types.ts';

export type MissCause = 'cold' | 'system_changed' | 'tools_changed' | 'model_changed' | 'idle_over_ttl' | 'below_minimum' | 'provider';
export type RequestCacheRow = { n: number; input: number; cacheRead: number; hit: number; reusable: number; cause?: MissCause };

// A request "misses" when the cached read falls more than one cache block short of the input the previous
// request already sent (providers cache whole blocks, e.g. 128 tokens on DeepSeek).
// Causes are checked from what the log can prove, most specific first; "provider" means the prefix did not change.
export function attributeMisses(events: SessionEvent[], opts: { blockTokens?: number; minTokens?: number } = {}): RequestCacheRow[] {
  const block = Math.max(1, opts.blockTokens ?? 1);
  const rows: RequestCacheRow[] = [];
  let prev: { req: EventOf<'request'>; at: number; input: number } | undefined;
  let pending: EventOf<'request'> | undefined;
  for (const e of events) {
    if (e.kind === 'request') pending = e;
    if (e.kind !== 'assistant' || !pending) continue;
    const u = e.usage;
    const input = u.uncached + u.cacheRead + u.cacheWrite;
    // What a perfect cache could have served: the previous input, rounded down to whole blocks.
    const reusable = prev ? Math.floor(prev.input / block) * block : 0;
    const row: RequestCacheRow = { n: rows.length + 1, input, cacheRead: u.cacheRead, hit: input ? u.cacheRead / input : 0, reusable };
    const at = Date.parse(pending.at);
    if (!prev) row.cause = 'cold';
    else if (u.cacheRead + block <= prev.input && u.cacheRead < Math.floor(prev.input / block) * block) {
      const ttlMs = pending.ttl === '1h' ? 3_600_000 : 300_000;
      if (pending.systemHash !== prev.req.systemHash) row.cause = 'system_changed';
      else if (pending.toolsHash !== prev.req.toolsHash) row.cause = 'tools_changed';
      else if (pending.model !== prev.req.model) row.cause = 'model_changed';
      else if (at - prev.at > ttlMs) row.cause = 'idle_over_ttl';
      else if (prev.input < (opts.minTokens ?? 0)) row.cause = 'below_minimum';
      else row.cause = 'provider';
    }
    rows.push(row);
    prev = { req: pending, at: Date.parse(e.at), input };
    pending = undefined;
  }
  return rows;
}
