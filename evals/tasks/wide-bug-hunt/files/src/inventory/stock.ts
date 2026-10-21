const STOCK = new Map<string, number>([
  ['MUG', 120],
  ['TEE', 40],
  ['CAP', 15],
  ['PEN', 900],
  ['BAG', 0],
]);

export const inStock = (sku: string, quantity: number) => (STOCK.get(sku) ?? 0) >= quantity;

export function reserve(sku: string, quantity: number): boolean {
  if (!inStock(sku, quantity)) return false;
  STOCK.set(sku, STOCK.get(sku)! - quantity);
  return true;
}
