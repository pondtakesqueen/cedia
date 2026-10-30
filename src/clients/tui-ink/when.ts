// How long ago an ISO time was, in the fewest words a list row needs:
// "now", "5m", "3h", "2d". Empty for a time that cannot be read or is ahead.
export function sinceLabel(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// The activity line while a failed request waits to go again: what failed, when it goes again, and which attempt
// that is ("overloaded (529), retrying in 8s, attempt 3 of 5"). A spent quota has no attempt count.
export function retryLabel(e: { n: number; waitMs: number; code: string; status?: number; of?: number }): string {
  const s = Math.max(1, Math.round(e.waitMs / 1000));
  const wait = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  const what = `${e.code.replace(/_/g, ' ')}${e.status !== undefined ? ` (${e.status})` : ''}`;
  if (e.code === 'quota') return `${what}, checking again in ${wait}`;
  return `${what}, retrying in ${wait}${e.of !== undefined ? `, attempt ${e.n + 1} of ${e.of}` : ''}`;
}
