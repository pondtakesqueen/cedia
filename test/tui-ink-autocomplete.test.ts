import { describe, expect, test } from 'bun:test';
import { fuzzyMatch, buildAutoItems, highlightSpans, truncateDescription, truncateLongText, estimateLines, loadFrecency, recordPick, frecencyBonus, type AutoItem } from '../src/clients/tui-ink/autocomplete.ts';

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

  test('frecency boosts picked items without overtaking prefixes', () => {
    const items = [{ value: 'status', name: '/status', description: '' }, { value: 'search', name: '/search', description: '' }, { value: 'cost', name: '/cost', description: '' }];
    const plain = buildAutoItems(items, [], 's');
    expect(plain.map((i) => i.name)).toEqual(['/search', '/status', '/cost']);
    // prefix still wins even with a big bonus on a fuzzy match
    const boosted = buildAutoItems(items, [], 's', (v) => frecencyBonus({ cost: { count: 9, last: Date.now() } }, v));
    expect(boosted[0]!.name).toBe('/search');
    // ...but frecency reorders among non-prefix fuzzy matches
    const items2 = [{ value: 'cost', name: '/cost', description: '' }, { value: 'docs', name: '/docs', description: '' }];
    const ranked = buildAutoItems(items2, [], 's', (v) => frecencyBonus({ cost: { count: 3, last: Date.now() } }, v));
    expect(ranked[0]!.name).toBe('/cost');
    expect(frecencyBonus({}, 'x')).toBe(0);
  });

  test('recordPick/loadFrecency round-trips through a file', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const p = join(mkdtempSync(join(tmpdir(), 'cedia-freq-')), 'f.json');
    expect(loadFrecency(p)).toEqual({});
    recordPick(p, '/commit');
    recordPick(p, '/commit');
    const m = loadFrecency(p);
    expect(m['/commit']!.count).toBe(2);
    expect(frecencyBonus(m, '/commit')).toBeGreaterThan(0);
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
