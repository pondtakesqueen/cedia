import { expect, test } from 'bun:test';
import { LRU, type EvictReason } from '../src/lru.ts';

const make = (capacity: number, ttl: number) => {
  let t = 0;
  const cache = new LRU<string, number>(capacity, ttl, () => t);
  const evicted: [string, number, EvictReason][] = [];
  cache.onEvict = (k, v, r) => evicted.push([k, v, r]);
  return { cache, evicted, at: (n: number) => (t = n) };
};

test('recency decides what capacity evicts', () => {
  const { cache, evicted } = make(2, 1000);
  cache.set('a', 1);
  cache.set('b', 2);
  expect(cache.get('a')).toBe(1);
  cache.set('c', 3);
  expect(evicted).toEqual([['b', 2, 'capacity']]);
  expect(cache.keys()).toEqual(['c', 'a']);
  cache.set('a', 10);
  expect(cache.keys()).toEqual(['a', 'c']);
  expect(cache.size).toBe(2);
});

test('entries expire at set time + ttl, and are removed when found', () => {
  const { cache, evicted, at } = make(3, 100);
  cache.set('a', 1);
  at(99);
  expect(cache.get('a')).toBe(1);
  at(100);
  expect(cache.size).toBe(0);
  expect(cache.get('a')).toBeUndefined();
  expect(evicted).toEqual([['a', 1, 'expired']]);
});

test('set clears expired entries before evicting a live one', () => {
  const { cache, evicted, at } = make(2, 100);
  cache.set('old', 1);
  at(50);
  cache.set('live', 2);
  at(120);
  cache.set('new', 3);
  expect(evicted).toEqual([['old', 1, 'expired']]);
  expect(cache.keys()).toEqual(['new', 'live']);
});

test('delete', () => {
  const { cache, evicted, at } = make(2, 100);
  cache.set('a', 1);
  cache.set('b', 2);
  expect(cache.delete('a')).toBe(true);
  expect(cache.delete('a')).toBe(false);
  at(200);
  expect(cache.delete('b')).toBe(false);
  expect(evicted).toEqual([['a', 1, 'delete'], ['b', 2, 'expired']]);
});
