import { expect, test } from 'bun:test';
import { search } from '../src/catalog/search.ts';
import { restockUnits } from '../src/inventory/restock.ts';
import { fill } from '../src/notify/templates.ts';
import { topSkus } from '../src/reports/top.ts';

test('the parts that are not pricing', () => {
  expect(search('a').map((p) => p.sku)).toEqual(['CAP', 'BAG']);
  expect(restockUnits(3, 20, 6)).toBe(18);
  expect(fill('hi {{name}} {{x}}', { name: 'Ann' })).toBe('hi Ann {{x}}');
  expect(topSkus(['A', 'B', 'B', 'C', 'C'], 2)).toEqual(['B', 'C']);
});
