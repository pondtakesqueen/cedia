import { expect, test } from 'bun:test';
import { slugify, uniqueSlug } from '../src/slug.ts';

test('slugify', () => {
  expect(slugify('Hello, World!')).toBe('hello-world');
  expect(slugify('  Crème brûlée à la française  ')).toBe('creme-brulee-a-la-francaise');
  expect(slugify('Straße & Æsir: Œuvre, Øre, Łódź, Đakovo')).toBe('strasse-aesir-oeuvre-ore-lodz-dakovo');
  expect(slugify('Mañana ¿qué?')).toBe('manana-que');
  expect(slugify('日本語 title 2024')).toBe('title-2024');
  expect(slugify('---')).toBe('');
  expect(slugify('a really long title here', 12)).toBe('a-really');
  expect(slugify('a really long title here', 13)).toBe('a-really-long');
  expect(slugify('supercalifragilistic', 5)).toBe('super');
  expect(slugify('short', 10)).toBe('short');
});

test('uniqueSlug', () => {
  expect(uniqueSlug('post', new Set())).toBe('post');
  expect(uniqueSlug('post', new Set(['post']))).toBe('post-2');
  expect(uniqueSlug('post', new Set(['post', 'post-2', 'post-3']))).toBe('post-4');
});
