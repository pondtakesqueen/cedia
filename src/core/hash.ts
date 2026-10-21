// Stable JSON (sorted keys) and short sha256, so equal values always hash equal.

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function hash(value: unknown): string {
  const text = typeof value === 'string' ? value : stableJson(value);
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16);
}
