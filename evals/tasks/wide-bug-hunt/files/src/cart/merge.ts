import type { Cart } from './cart.ts';

// Two lines of the same sku become one; the cart keeps the first coupon it saw.
export function mergeLines(c: Cart): Cart {
  const by = new Map<string, Cart['lines'][number]>();
  for (const l of c.lines) {
    const seen = by.get(l.sku);
    if (seen) seen.quantity += l.quantity;
    else by.set(l.sku, { ...l });
  }
  return { ...c, lines: [...by.values()] };
}
