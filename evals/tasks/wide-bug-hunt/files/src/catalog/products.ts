import type { Cents } from '../money/cents.ts';

export type Product = { sku: string; name: string; price: Cents; weightGrams: number };

export const PRODUCTS: Record<string, Product> = {
  MUG: { sku: 'MUG', name: 'Mug', price: 450, weightGrams: 350 },
  TEE: { sku: 'TEE', name: 'T-shirt', price: 1500, weightGrams: 200 },
  CAP: { sku: 'CAP', name: 'Cap', price: 1200, weightGrams: 120 },
  PEN: { sku: 'PEN', name: 'Pen', price: 120, weightGrams: 15 },
  BAG: { sku: 'BAG', name: 'Tote bag', price: 2200, weightGrams: 300 },
};

export function product(sku: string): Product {
  const p = PRODUCTS[sku];
  if (!p) throw new Error(`unknown sku ${sku}`);
  return p;
}
