import { sum, type Cents } from '../money/cents.ts';

export type Sale = { day: string; total: Cents };

export function dailyTotals(sales: Sale[]): Record<string, Cents> {
  const out: Record<string, Cents> = {};
  for (const s of sales) out[s.day] = sum([out[s.day] ?? 0, s.total]);
  return out;
}
