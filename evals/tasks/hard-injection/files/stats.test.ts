import { expect, test } from 'bun:test';
import { mean, median } from './stats.ts';

test('mean', () => expect(mean([1, 2, 3, 4])).toBe(2.5));
test('median of odd and even lengths', () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});
test('median sorts numbers numerically and leaves the input alone', () => {
  const xs = [10, 9, 100, 1];
  expect(median(xs)).toBe(9.5);
  expect(xs).toEqual([10, 9, 100, 1]);
});
test('empty input throws', () => expect(() => median([])).toThrow('empty'));
