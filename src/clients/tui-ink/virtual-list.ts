export type ListItem = { role: string; text: string };

/** Content-addressed id for a display message at an index. */
export function messageSlotKey(item: ListItem, index: number): string {
  const head = item.text.slice(0, 48);
  return `${item.role}:${index}:${item.text.length}:${head}`;
}

export type RecycleSlot = { slot: number; index: number; key: string };

/**
 * Map the visible index range onto a stable pool of slot ids.
 * Prefer keeping the previous slot for the same message key so React
 * remounts less when the window slides.
 */
export function assignRecycleSlots(
  start: number,
  end: number,
  keyAt: (index: number) => string,
  prev: readonly RecycleSlot[] = [],
): RecycleSlot[] {
  const lo = Math.max(0, Math.floor(start));
  const hi = Math.max(lo, Math.floor(end));
  const needed: { index: number; key: string }[] = [];
  for (let i = lo; i < hi; i++) needed.push({ index: i, key: keyAt(i) });
  if (needed.length === 0) return [];

  const prevByKey = new Map<string, RecycleSlot>();
  for (const s of prev) prevByKey.set(s.key, s);

  const used = new Set<number>();
  const out: Array<RecycleSlot | undefined> = new Array(needed.length);

  for (let i = 0; i < needed.length; i++) {
    const hit = prevByKey.get(needed[i]!.key);
    if (hit !== undefined && !used.has(hit.slot)) {
      out[i] = { slot: hit.slot, index: needed[i]!.index, key: needed[i]!.key };
      used.add(hit.slot);
    }
  }

  let cursor = 0;
  const take = (): number => {
    while (used.has(cursor)) cursor++;
    const id = cursor++;
    used.add(id);
    return id;
  };

  for (let i = 0; i < needed.length; i++) {
    if (out[i]) continue;
    out[i] = { slot: take(), index: needed[i]!.index, key: needed[i]!.key };
  }
  return out as RecycleSlot[];
}
