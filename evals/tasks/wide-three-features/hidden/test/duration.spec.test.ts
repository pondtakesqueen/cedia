import { expect, test } from 'bun:test';
import { formatDuration, parseDuration } from '../src/duration.ts';

test('parseDuration', () => {
  expect(parseDuration('90s')).toBe(90_000);
  expect(parseDuration('1h30m')).toBe(5_400_000);
  expect(parseDuration('1.5h')).toBe(5_400_000);
  expect(parseDuration('2d 4h')).toBe(187_200_000);
  expect(parseDuration('250ms')).toBe(250);
  expect(parseDuration(' 1m 1s 1ms ')).toBe(61_001);
  expect(parseDuration('0.0015s')).toBe(2);
  for (const bad of ['', '10', '5x', 'h', '-1s', '1h 2', 'ms'])
    expect(() => parseDuration(bad)).toThrow(`"${bad}"`);
});

test('formatDuration', () => {
  expect(formatDuration(5_400_000)).toBe('1h30m');
  expect(formatDuration(1_500)).toBe('1s500ms');
  expect(formatDuration(0)).toBe('0s');
  expect(formatDuration(187_200_000)).toBe('2d4h');
  expect(formatDuration(61_001)).toBe('1m1s1ms');
  expect(() => formatDuration(-1)).toThrow();
  for (const t of ['3d', '1h1m1s', '45m', '999ms']) expect(formatDuration(parseDuration(t))).toBe(t);
});
