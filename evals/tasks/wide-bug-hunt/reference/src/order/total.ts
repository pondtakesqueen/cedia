import type { Cart } from '../cart/cart.ts';
import { sum, type Cents } from '../money/cents.ts';
import { couponDiscount } from '../pricing/discounts/coupons.ts';
import { priceLine, type PricedLine } from '../pricing/lines.ts';
import { region } from '../pricing/regions.ts';
import { shippingFor } from '../pricing/shipping.ts';
import { taxFor } from '../pricing/tax.ts';

export type Totals = { lines: PricedLine[]; subtotal: Cents; coupon: Cents; shipping: Cents; tax: Cents; total: Cents };

export function totals(c: Cart): Totals {
  const r = region(c.region);
  const lines = c.lines.map(priceLine);
  const subtotal = sum(lines.map((l) => l.total));
  const coupon = couponDiscount(c.coupon, subtotal);
  const discounted = subtotal - coupon;
  const shipping = shippingFor(r, discounted);
  const tax = taxFor(r, discounted + shipping);
  return { lines, subtotal, coupon, shipping, tax, total: discounted + shipping + tax };
}
