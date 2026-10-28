import { describe, expect, test } from 'bun:test';
import { fuzzyMatch, buildAutoItems, highlightSpans, truncateDescription, truncateLongText, estimateLines, type AutoItem } from '../src/clients/tui-ink/autocomplete.ts';

const cmds = (names: string[]): AutoItem[] => names.map((n) => ({ value: n, name: `/${n}`, description: `${n} does things` }));

describe('autocomplete', () => {
  test('fuzzyMatch matches prefixes and subsequences', () => {
    expect(fuzzyMatch('status', 's')).toEqual([0]);
    expect(fuzzyMatch('status', 'st')).toEqual([0, 1]);
    expect(fuzzyMatch('statusline', 'sl')).toEqual([0, 6]);
    expect(fuzzyMatch('status', 'x')).toBeNull();
    expect(fuzzyMatch('status', 'stx')).toBeNull();
    expect(fuzzyMatch('status', '')).toEqual([]);
  });

  test('fuzzyMatch is case-insensitive', () => {
    expect(fuzzyMatch('Status', 's')).toEqual([0]);
  });

  test('buildAutoItems ranks prefix matches first', () => {
    const items = buildAutoItems(cmds(['status', 'suggest', 'cost']), [], 's');
    expect(items.map((i) => i.name)).toEqual(['/status', '/suggest', '/cost']);
    expect(items[0]!.hits).toEqual([0]);
    expect(items[2]!.hits).toEqual([2]);
  });

  test('buildAutoItems filters non-matches and keeps skills after commands', () => {
    const skills: AutoItem[] = [{ value: 'setup-x', name: 'setup-x', description: 'sets up' }];
    const items = buildAutoItems(cmds(['status', 'diff']), skills, 's');
    expect(items.map((i) => i.name)).toEqual(['/status', 'setup-x']);
  });

  test('buildAutoItems with empty query returns everything', () => {
    const items = buildAutoItems(cmds(['b', 'a']), [], '');
    expect(items).toHaveLength(2);
  });

  test('highlightSpans splits hit runs', () => {
    expect(highlightSpans('status', [0, 1])).toEqual([
      { text: 'st', hit: true },
      { text: 'atus', hit: false },
    ]);
    expect(highlightSpans('statusline', [0, 6])).toEqual([
      { text: 's', hit: true },
      { text: 'tatus', hit: false },
      { text: 'l', hit: true },
      { text: 'ine', hit: false },
    ]);
  });

  test('truncateDescription truncates with ellipsis', () => {
    expect(truncateDescription('hello world', 20)).toBe('hello world');
    expect(truncateDescription('hello world', 5)).toBe('hell…');
  });

  test('a boost reorders fuzzy matches but never lifts one over a prefix match', () => {
    const items = [{ value: 'status', name: '/status', description: '' }, { value: 'search', name: '/search', description: '' }, { value: 'cost', name: '/cost', description: '' }];
    expect(buildAutoItems(items, [], 's').map((i) => i.name)).toEqual(['/search', '/status', '/cost']);
    expect(buildAutoItems(items, [], 's', (v) => (v === 'cost' ? 900 : 0))[0]!.name).toBe('/search');
    const fuzzy = [{ value: 'cost', name: '/cost', description: '' }, { value: 'docs', name: '/docs', description: '' }];
    expect(buildAutoItems(fuzzy, [], 's', (v) => (v === 'cost' ? 300 : 0))[0]!.name).toBe('/cost');
  });

  test('estimateLines counts wrapped rows', () => {
    expect(estimateLines('hi', 80)).toBe(1);
    expect(estimateLines('a'.repeat(80), 80)).toBe(1);
    expect(estimateLines('a'.repeat(81), 80)).toBe(2);
    expect(estimateLines('a\nb\nc', 80)).toBe(3);
    expect(estimateLines('', 80)).toBe(1);
  });

  test('truncateLongText caps huge pastes with head/tail', () => {
    expect(truncateLongText('short')).toBe('short');
    const big = `${'a'.repeat(3000)}\n${'b'.repeat(4000)}\n${'c'.repeat(4000)}`;
    const out = truncateLongText(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('… +');
    expect(out).toContain('lines …');
    expect(out.startsWith('a'.repeat(100))).toBe(true);
    expect(out.endsWith('c'.repeat(100))).toBe(true);
  });
});
