import type { Cents } from '../money/cents.ts';

// One point per whole currency unit spent; points never affect prices.
export const pointsFor = (total: Cents) => Math.floor(total / 100);
