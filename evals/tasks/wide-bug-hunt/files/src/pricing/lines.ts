import type { Line } from '../cart/cart.ts';
import type { Cents } from '../money/cents.ts';
import { bulkDiscount } from './discounts/bulk.ts';

export type PricedLine = Line & { subtotal: Cents; discount: Cents; total: Cents };

export function priceLine(line: Line): PricedLine {
  const subtotal = line.unitPrice * line.quantity;
  const discount = bulkDiscount(line.quantity, subtotal);
  return { ...line, subtotal, discount, total: subtotal - discount };
}
