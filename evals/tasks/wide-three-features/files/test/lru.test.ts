import { expect, test } from 'bun:test';
import { LRU } from '../src/lru.ts';

test('lru examples', () => {
  let t = 0;
  const cache = new LRU<string, number>(2, 1000, () => t);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  expect(cache.get('a')).toBeUndefined();
  expect(cache.keys()).toEqual(['c', 'b']);
  t = 1000;
  expect(cache.get('b')).toBeUndefined();
});
