import { describe, expect, test } from 'bun:test';
import { getStyle, loadOutputStyles } from '../src/core/output-styles/styles.ts';

describe('output styles', () => {
  test('terse reports short with exact payloads, keeping notes and findings full', () => {
    const names = loadOutputStyles().map((s) => s.name);
    expect(names).toContain('terse');
    const mod = getStyle('terse')!.promptModifier;
    expect(mod).toContain('character for character');
    expect(mod).toContain('Handoff notes');
    expect(getStyle('nope')).toBeUndefined();
  });
});
