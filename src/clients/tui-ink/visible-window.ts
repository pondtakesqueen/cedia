export type HeightCache = {
  lines(key: string, compute: () => number): number;
  clear(): void;
  get size(): number;
};

export function createHeightCache(): HeightCache {
  const map = new Map<string, number>();
  return {
    lines(key, compute) {
      const hit = map.get(key);
      if (hit !== undefined) return hit;
      const value = Math.max(1, compute());
      map.set(key, value);
      return value;
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

export function heightCacheKey(index: number, width: number, textLen: number, role: string): string {
  return `${index}:${width}:${textLen}:${role}`;
}

export type VisibleWindow = {
  start: number;
  end: number;
  used: number;
};

export function visibleWindow(opts: {
  count: number;
  scrollOffset: number;
  budget: number;
  overscan?: number;
  heightAt: (index: number) => number;
}): VisibleWindow {
  const count = Math.max(0, Math.floor(opts.count));
  if (count === 0) return { start: 0, end: 0, used: 0 };
  const scroll = Math.max(0, Math.floor(opts.scrollOffset));
  const end = Math.max(0, Math.min(count, count - scroll));
  let start = end;
  let used = 0;
  const budget = Math.max(1, opts.budget);
  while (start > 0) {
    const h = Math.max(1, opts.heightAt(start - 1));
    if (used + h > budget && start < end) break;
    used += h;
    start--;
  }
  const overscan = Math.max(0, Math.floor(opts.overscan ?? 3));
  return { start: Math.max(0, start - overscan), end, used };
}
