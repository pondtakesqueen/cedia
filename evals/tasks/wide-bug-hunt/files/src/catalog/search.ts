import { PRODUCTS, type Product } from './products.ts';

// Case-insensitive name search, cheapest first.
export function search(term: string): Product[] {
  const t = term.toLowerCase();
  return Object.values(PRODUCTS)
    .filter((p) => p.name.toLowerCase().includes(t))
    .sort((a, b) => a.price - b.price);
}
