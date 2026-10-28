import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConsolidateMemory } from '../src/core/config.ts';

const before = process.env.CEDIA_HOME;
afterEach(() => {
  if (before === undefined) delete process.env.CEDIA_HOME;
  else process.env.CEDIA_HOME = before;
});

function home(settings: object): void {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-cm-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  process.env.CEDIA_HOME = dir;
}

describe('consolidateMemory setting', () => {
  test('the new key is read without a note', () => {
    home({ consolidateMemory: true });
    const notes: string[] = [];
    expect(loadConsolidateMemory(undefined, (l) => notes.push(l))).toBe(true);
    expect(notes).toEqual([]);
  });

  test('the old autoDream key still works, with a note', () => {
    home({ autoDream: true });
    const notes: string[] = [];
    expect(loadConsolidateMemory(undefined, (l) => notes.push(l))).toBe(true);
    expect(notes[0]).toContain('consolidateMemory');
  });

  test('the new key wins over the old, and the flag over both', () => {
    home({ consolidateMemory: false, autoDream: true });
    expect(loadConsolidateMemory(undefined, () => {})).toBe(false);
    expect(loadConsolidateMemory('on', () => {})).toBe(true);
    expect(() => loadConsolidateMemory('maybe')).toThrow('--consolidate-memory');
  });

  test('off when neither is set', () => {
    home({});
    expect(loadConsolidateMemory(undefined, () => {})).toBe(false);
  });
});
