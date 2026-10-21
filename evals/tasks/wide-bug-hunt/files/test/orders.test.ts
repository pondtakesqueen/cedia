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

  test('exactly 10 units get the 5% bulk tier', () => {
    // 10 pens = 1200, 5% off = 60 -> 1140; US shipping 800; tax 7% of 1940 = 135.8 -> 136
    const t = totals(cart('US', [['PEN', 10]]));
    expect(t.lines[0]).toMatchObject({ subtotal: 1200, discount: 60, total: 1140 });
    expect(t).toMatchObject({ subtotal: 1140, shipping: 800, tax: 136, total: 2076 });
  });

  test('exactly 50 units get the 10% tier, not 5%', () => {
    // 50 pens = 6000, 10% off = 600 -> 5400 >= 5000 so US shipping is free; tax 7% of 5400 = 378
    expect(totals(cart('US', [['PEN', 50]]))).toMatchObject({ subtotal: 5400, shipping: 0, tax: 378, total: 5778 });
  });

  test('a coupon that takes the order under the threshold brings shipping back', () => {
    // 4 tees = 6000 (EU free from 6000); SAVE10 -> 5400, under 6000, so shipping 900; tax 20% of 6300 = 1260
    expect(totals(cart('EU', [['TEE', 4]], 'SAVE10'))).toMatchObject({ subtotal: 6000, coupon: 600, shipping: 900, tax: 1260, total: 7560 });
  });

  test('FLAT5 never takes an order below zero', () => {
    // 1 pen = 120; FLAT5 takes 120; shipping 700; tax 20% of 700 = 140
    expect(totals(cart('UK', [['PEN', 1]], 'flat5'))).toMatchObject({ coupon: 120, shipping: 700, tax: 140, total: 840 });
  });
});
