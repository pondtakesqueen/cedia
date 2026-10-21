// Whole cents. Fractions only appear inside a calculation and are rounded once, at the end of it.
export type Cents = number;

export const cents = (n: number): Cents => Math.round(n);

export function sum(values: Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}
