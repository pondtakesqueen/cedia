import { expect, test } from 'bun:test';
import { progressOf, todoOf } from '../src/core/tools/todo.ts';

test('a todo list: text and a state for each item, at most 20', () => {
  expect(todoOf({ items: [{ text: ' a ', state: 'done' }, { text: 'b', state: 'doing' }] })).toEqual([
    { text: 'a', state: 'done' },
    { text: 'b', state: 'doing' },
  ]);
  expect(todoOf({ items: 'x' })).toBe('items must be a list');
  expect(todoOf({ items: [{ text: 'a', state: 'later' }] })).toBe("an item's state is pending, doing, done");
  expect(todoOf({ items: Array.from({ length: 21 }, () => ({ text: 'a', state: 'pending' })) })).toBe('at most 20 items');
  expect(todoOf({ items: [] })).toEqual([]);
});

test('progress: done of total, and the step being done or else the next', () => {
  expect(progressOf([{ text: 'a', state: 'done' }, { text: 'b', state: 'pending' }, { text: 'c', state: 'doing' }])).toEqual({ done: 1, total: 3, now: 'c' });
  expect(progressOf([{ text: 'a', state: 'done' }, { text: 'b', state: 'pending' }])).toEqual({ done: 1, total: 2, now: 'b' });
  expect(progressOf([{ text: 'a', state: 'done' }])).toEqual({ done: 1, total: 1 });
});
