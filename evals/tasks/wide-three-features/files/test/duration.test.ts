import { expect, test } from 'bun:test';
import { formatDuration, parseDuration } from '../src/duration.ts';

test('duration examples', () => {
  expect(parseDuration('90s')).toBe(90_000);
  expect(parseDuration('1h30m')).toBe(5_400_000);
  expect(formatDuration(5_400_000)).toBe('1h30m');
  expect(() => parseDuration('5x')).toThrow('"5x"');
});
