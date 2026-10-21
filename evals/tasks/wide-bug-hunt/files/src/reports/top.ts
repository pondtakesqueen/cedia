// The n most frequent skus, ties broken by sku.
export function topSkus(skus: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const s of skus) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([s]) => s);
}
