import { expect, test } from 'bun:test';
import { approachesOf, bestOfReport, bestTry, type Try } from '../src/core/project/bestof.ts';

const t = (over: Partial<Try>): Try => ({ approach: 'a', subtype: 'success', passed: 0, checks: 2, unverified: 0, costUsd: 0, ...over });

test('the try that passes most checks is kept, then success, then fewest unverified, then the cheapest', () => {
  expect(bestTry([t({ passed: 1 }), t({ passed: 2, subtype: 'error_max_turns' }), t({ passed: 1 })])).toBe(1);
  expect(bestTry([t({ passed: 2, subtype: 'error_max_turns' }), t({ passed: 2 })])).toBe(1);
  expect(bestTry([t({ unverified: 2 }), t({ unverified: 1 })])).toBe(1);
  expect(bestTry([t({ costUsd: 0.2 }), t({ costUsd: 0.1 })])).toBe(1);
  expect(bestTry([t({}), t({})])).toBe(0);
  expect(bestTry([t({ subtype: 'interrupted', passed: 2 }), t({ passed: 0 })])).toBe(1);
  expect(bestTry([t({ subtype: 'interrupted' })])).toBeUndefined();
});

test('approaches: 2 to 4 different non-empty strings', () => {
  expect(approachesOf(undefined)).toBeUndefined();
  expect(approachesOf(['x', ' y '])).toEqual(['x', 'y']);
  expect(approachesOf(['x'])).toEqual({ error: 'approaches takes 2 to 4 different approaches' });
  expect(approachesOf(['x', 'x '])).toEqual({ error: 'approaches takes 2 to 4 different approaches' });
  expect(approachesOf(['a', 'b', 'c', 'd', 'e'])).toMatchObject({ error: expect.any(String) });
  expect(approachesOf(['a', ''])).toEqual({ error: 'approaches must be a list of non-empty strings' });
  expect(approachesOf('a')).toEqual({ error: 'approaches must be a list of non-empty strings' });
});

test('the report says which was kept and how each did', () => {
  const r = bestOfReport([t({ approach: 'cache it', passed: 1, thread: 't1' }), t({ approach: 'index it', passed: 2 })], 1);
  expect(r).toBe('Best of 2: kept approach 2; the others\' changes were dropped.\n1. cache it: 1/2 checks passed, ended success, thread t1\n2. index it: 2/2 checks passed, ended success (kept)');
});
