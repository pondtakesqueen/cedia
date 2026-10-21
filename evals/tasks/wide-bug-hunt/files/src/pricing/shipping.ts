import type { Cents } from '../money/cents.ts';
import type { Region } from './regions.ts';

// What shipping costs for an order whose amount, as the caller decides it, is `amount`.
export function shippingFor(r: Region, amount: Cents): Cents {
  return amount >= r.freeShippingFrom ? 0 : r.shipping;
}
