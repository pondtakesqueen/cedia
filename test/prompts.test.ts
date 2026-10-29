import { describe, expect, test } from 'bun:test';
import { BASE_SYSTEM, preamble, READ_ONLY_SYSTEM, systemFor } from '../src/core/prompts.ts';
import { CATALOG, FAUX_MODEL, resolveModel } from '../src/core/providers/catalog.ts';

describe('system prompt per model', () => {
  test("DeepSeek Flash and Opus get their own lines after the base; other models get the base alone", () => {
    for (const ref of ['opencode-go/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash', 'openrouter/deepseek-v4.1-flash']) {
      const s = systemFor(resolveModel(ref));
      expect(s.startsWith(`${BASE_SYSTEM}\n\nFor this model in particular:\n`)).toBe(true);
      expect(s).toContain('Do not create test files of your own.');
      expect(s).toContain('Run a check once after your last change.');
    }
    expect(systemFor(resolveModel('haiku'))).toBe(BASE_SYSTEM);
    for (const ref of ['opus', 'anthropic/claude-opus-5-5-fast']) {
      const s = systemFor(resolveModel(ref));
      expect(s.startsWith('You are cedia')).toBe(true);
      expect(s).toContain('\n\nFor this model in particular, correctness comes before brevity:\n');
      expect(s).toContain('Walk the failure paths');
    }
    expect(systemFor(resolveModel('sonnet'))).toBe(BASE_SYSTEM);
    expect(systemFor(FAUX_MODEL)).toBe(BASE_SYSTEM);
  });

  test("Opus gets the base without its turn-saving lines; every other model keeps them word for word", () => {
    const turnSaving = ['so it costs the user time and money', 'Extra probes, edge cases or improvements nobody asked for widen the change and cost turns'];
    for (const m of CATALOG) {
      const s = systemFor(m);
      for (const line of turnSaving) expect(s.includes(line)).toBe(!m.thorough);
      if (!m.thorough) expect(s.startsWith(BASE_SYSTEM)).toBe(true);
    }
    expect(CATALOG.filter((m) => m.thorough).map((m) => m.ref)).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5-fast']);
    const opus = systemFor(resolveModel('opus'));
    expect(opus).toContain('once every rule the task states holds and a declared check passes after your last change');
    expect(opus).toContain('Leave improvements nobody asked for out of the change.');
  });

  test('a session that only reads is not told to edit, check its change or read its own diff', () => {
    for (const line of ['Change files with edit', 'Run the project\'s checks after a change', 'git diff', 'smallest change'])
      expect([line, READ_ONLY_SYSTEM.includes(line)]).toEqual([line, false]);
    expect(READ_ONLY_SYSTEM).toContain('you change nothing');
    expect(READ_ONLY_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}|\/home\/|\/Users\/|\$\{/);
  });

  test('a model prompt holds no per-session value, so the prefix stays cacheable (cache rule 1)', () => {
    for (const m of CATALOG.filter((c) => c.prompt)) expect(m.prompt).not.toMatch(/\d{4}-\d{2}-\d{2}|\/home\/|\/Users\/|\$\{/);
  });

  test('the sandbox line names $TMPDIR as the place for scratch files', () => {
    const p = preamble('/w', { sandbox: { on: true, allowedDomains: [] } }, new Date('2026-10-22'));
    expect(p).toContain('the temp dir ($TMPDIR, which is not always /tmp: put scratch files there or in the working directory)');
  });
});
