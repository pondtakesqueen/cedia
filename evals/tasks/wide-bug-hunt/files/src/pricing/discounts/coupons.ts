import type { Cents } from '../../money/cents.ts';
import { percentOf } from '../../money/round.ts';

export type Coupon = { code: string; apply(amount: Cents): Cents };

const COUPONS: Coupon[] = [
  { code: 'SAVE10', apply: (amount) => percentOf(amount, 0.1) },
  { code: 'FLAT5', apply: (amount) => Math.min(500, amount) },
];

// The discount a coupon gives on an amount; unknown codes give none.
export function couponDiscount(code: string | undefined, amount: Cents): Cents {
  if (!code) return 0;
  const c = COUPONS.find((x) => x.code === code.toUpperCase());
  return c ? c.apply(amount) : 0;
}
