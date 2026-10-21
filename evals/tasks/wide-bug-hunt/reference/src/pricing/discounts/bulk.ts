import type { Cents } from '../../money/cents.ts';
import { percentOf } from '../../money/round.ts';

// Tiers from the highest down; the first that applies wins.
const TIERS = [
  { min: 50, rate: 0.1 },
  { min: 10, rate: 0.05 },
];

export function bulkDiscount(quantity: number, subtotal: Cents): Cents {
  const tier = TIERS.find((t) => quantity >= t.min);
  return tier ? percentOf(subtotal, tier.rate) : 0;
}
