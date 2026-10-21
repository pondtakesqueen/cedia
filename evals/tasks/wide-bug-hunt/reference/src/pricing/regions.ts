import type { Cents } from '../money/cents.ts';

export type Region = { code: string; taxRate: number; shipping: Cents; freeShippingFrom: Cents };

export const REGIONS: Record<string, Region> = {
  US: { code: 'US', taxRate: 0.07, shipping: 800, freeShippingFrom: 5000 },
  EU: { code: 'EU', taxRate: 0.2, shipping: 900, freeShippingFrom: 6000 },
  UK: { code: 'UK', taxRate: 0.2, shipping: 700, freeShippingFrom: 4000 },
};

export function region(code: string): Region {
  const r = REGIONS[code];
  if (!r) throw new Error(`unknown region ${code}`);
  return r;
}
