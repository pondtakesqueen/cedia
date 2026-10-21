import { describe, expect, test } from 'bun:test';
import { cart } from '../src/cart/cart.ts';
import { totals } from '../src/order/total.ts';

// Expected values worked by hand from the rules in README.md.
describe('order totals', () => {
  test('a plain US order pays shipping and 7% tax', () => {
    // 2 mugs = 900; shipping 800; tax 7% of 1700 = 119
    expect(totals(cart('US', [['MUG', 2]]))).toMatchObject({ subtotal: 900, coupon: 0, shipping: 800, tax: 119, total: 1819 });
  });

  test('a large UK order ships free', () => {
    // 3 bags = 6600 >= 4000; tax 20% of 6600 = 1320
    expect(totals(cart('UK', [['BAG', 3]]))).toMatchObject({ subtotal: 6600, shipping: 0, tax: 1320, total: 7920 });
  });
});
