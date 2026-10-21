import { expect, test } from 'bun:test';
import { money } from '../src/format/currency.ts';
import { percentOf, roundHalfUp } from '../src/money/round.ts';

test('rounding and formatting', () => {
  expect(roundHalfUp(12.5)).toBe(13);
  expect(roundHalfUp(12.49)).toBe(12);
  expect(percentOf(1999, 0.07)).toBe(140);
  expect(money(123456)).toBe('1,234.56');
  expect(money(-5)).toBe('-0.05');
});
