import { product } from '../catalog/products.ts';
import type { Cents } from '../money/cents.ts';

export type Line = { sku: string; quantity: number; unitPrice: Cents };
export type Cart = { lines: Line[]; coupon?: string; region: string };

export function cart(region: string, items: [sku: string, quantity: number][], coupon?: string): Cart {
  const lines = items.map(([sku, quantity]) => {
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`bad quantity for ${sku}: ${quantity}`);
    return { sku, quantity, unitPrice: product(sku).price };
  });
  return { lines, region, ...(coupon ? { coupon } : {}) };
}
