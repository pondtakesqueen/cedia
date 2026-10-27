import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome } from '../config.ts';

export async function fetchMdmSettings(url = process.env.CEDIA_MDM_URL, timeoutMs = 3000): Promise<Record<string, unknown>> {
  if (!url) return {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  } finally {
    clearTimeout(t);
  }
}

// Remote polling for the managed tier: `cedia mdm sync` fetches once by hand; the daemon refetches on its
// own when the cache is older than the poll interval, so org policy rolls out without anyone running a
// command. Fail-open throughout: a missing URL, a stale read, or a failed fetch never throws and never
// blocks a run — the file cache (or nothing) is what loads.

export const MDM_POLL_MINUTES_DEFAULT = 60;
export const MDM_POLL_MINUTES_MIN = 5;

export const mdmCachePath = (home = cediaHome()) => join(home, 'mdm-cache', 'managed-settings.json');

export function mdmPollMinutes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CEDIA_MDM_POLL_MIN);
  if (env.CEDIA_MDM_POLL_MIN === undefined || !Number.isFinite(n)) return MDM_POLL_MINUTES_DEFAULT;
  return Math.max(MDM_POLL_MINUTES_MIN, Math.floor(n));
}

// True when a URL is set and there is nothing cached, or the cache is older than the poll interval.
export function mdmCacheStale(home = cediaHome(), now = Date.now(), env: Record<string, string | undefined> = process.env): boolean {
  if (!env.CEDIA_MDM_URL) return false;
  try {
    if (!existsSync(mdmCachePath(home))) return true;
    return statSync(mdmCachePath(home)).mtimeMs < now - mdmPollMinutes(env) * 60_000;
  } catch {
    return true;
  }
}

export type MdmRefresh = 'fresh' | 'refreshed' | 'no-url' | 'failed';

// Refetch when stale and write the cache. Never throws: 'failed' (or 'no-url'/'fresh') leaves the run to
// whatever the file cache holds.
export async function refreshMdmIfStale(home = cediaHome(), env: Record<string, string | undefined> = process.env): Promise<MdmRefresh> {
  if (!env.CEDIA_MDM_URL) return 'no-url';
  if (!mdmCacheStale(home, Date.now(), env)) return 'fresh';
  try {
    const data = await fetchMdmSettings(env.CEDIA_MDM_URL);
    // Empty is no data (a dead endpoint answers the same way): leave a good cache alone rather than
    // clobber it, and stay stale so the next pass tries again.
    if (!Object.keys(data).length) return 'failed';
    mkdirSync(join(home, 'mdm-cache'), { recursive: true });
    writeFileSync(mdmCachePath(home), JSON.stringify(data, null, 2) + '\n');
    return 'refreshed';
  } catch {
    return 'failed';
  }
}
