import { expect, test } from 'bun:test';
import { slugify, uniqueSlug } from '../src/slug.ts';

test('slug examples', () => {
  expect(slugify('Hello, World!')).toBe('hello-world');
  expect(slugify('Crème brûlée')).toBe('creme-brulee');
  expect(uniqueSlug('post', new Set(['post']))).toBe('post-2');
});
