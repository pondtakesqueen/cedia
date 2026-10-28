import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPick, pickBoost, readPicks, savePick } from '../src/clients/tui-ink/picks.ts';
import { sinceLabel } from '../src/clients/tui-ink/when.ts';
import { bindingSummary } from '../src/clients/tui-ink/keybindings/summary.ts';

const DAY = 24 * 3600_000;

describe('picks', () => {
  test('a pick boosts its value, and the boost halves after a week', () => {
    const now = 100 * DAY;
    expect(pickBoost({}, 'x', now)).toBe(0);
    const fresh = pickBoost(addPick({}, 'commit', now), 'commit', now);
    const weekOld = pickBoost(addPick({}, 'commit', now - 7 * DAY), 'commit', now);
    expect(fresh).toBe(150);
    expect(weekOld).toBe(75);
  });

  test('the boost stays under the prefix gap however often a value is picked', () => {
    let log = {};
    for (let i = 0; i < 50; i++) log = addPick(log, 'diff', 1000 + i);
    expect(log['diff' as keyof typeof log]).toHaveLength(20);
    expect(pickBoost(log, 'diff', 2000)).toBe(900);
  });

  test('old values give way once the log is full', () => {
    let log = {};
    for (let i = 0; i < 301; i++) log = addPick(log, `v${i}`, i);
    expect(Object.keys(log)).toHaveLength(300);
    expect('v0' in log).toBe(false);
  });

  test('picks round-trip through a file, and a bad file reads as empty', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'cedia-picks-')), 'picks.json');
    expect(readPicks(p)).toEqual({});
    savePick(p, '/commit', 5);
    savePick(p, '/commit', 6);
    expect(readPicks(p)).toEqual({ '/commit': [5, 6] });
    writeFileSync(p, '[1,2]');
    expect(readPicks(p)).toEqual({});
  });
});

describe('sinceLabel', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  test('says how long ago in the fewest words', () => {
    expect(sinceLabel('2026-10-28T11:59:40Z', now)).toBe('now');
    expect(sinceLabel('2026-10-28T11:55:00Z', now)).toBe('5m');
    expect(sinceLabel('2026-10-28T09:00:00Z', now)).toBe('3h');
    expect(sinceLabel('2026-10-26T12:00:00Z', now)).toBe('2d');
  });
  test('is empty for a time it cannot read or one ahead', () => {
    expect(sinceLabel('soon', now)).toBe('');
    expect(sinceLabel('2026-10-29T00:00:00Z', now)).toBe('');
  });
});

describe('bindingSummary', () => {
  test('names each rebound key with what it does', () => {
    expect(bindingSummary([])).toBe('');
    expect(bindingSummary([{ key: 'ctrl+j', command: 'submit' }, { key: 'ctrl+k', command: 'palette' }])).toBe('ctrl+j send · ctrl+k palette');
  });
});
