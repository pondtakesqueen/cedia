import type { Cents } from './cents.ts';

// Half up: 12.5 -> 13. Tax amounts are never negative, so the sign rule does not matter here.
export function roundHalfUp(x: number): Cents {
  return Math.floor(x + 0.5);
}

// Applies a rate (0.2 for 20%) to an amount and rounds once.
export function percentOf(amount: Cents, rate: number): Cents {
  return roundHalfUp(amount * rate);
}
