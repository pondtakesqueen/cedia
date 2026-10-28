import { describe, expect, test } from 'bun:test';
import { BASE_SYSTEM, preamble, systemFor } from '../src/core/prompts.ts';
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
      expect(s.startsWith(`${BASE_SYSTEM}\n\nFor this model in particular, correctness comes before brevity:\n`)).toBe(true);
      expect(s).toContain('Walk the failure paths');
    }
    expect(systemFor(resolveModel('sonnet'))).toBe(BASE_SYSTEM);
    expect(systemFor(FAUX_MODEL)).toBe(BASE_SYSTEM);
  });

  test('a model prompt holds no per-session value, so the prefix stays cacheable (cache rule 1)', () => {
    for (const m of CATALOG.filter((c) => c.prompt)) expect(m.prompt).not.toMatch(/\d{4}-\d{2}-\d{2}|\/home\/|\/Users\/|\$\{/);
  });

  test('the sandbox line names $TMPDIR as the place for scratch files', () => {
    const p = preamble('/w', { sandbox: { on: true, allowedDomains: [] } }, new Date('2026-10-22'));
    expect(p).toContain('the temp dir ($TMPDIR, which is not always /tmp: put scratch files there or in the working directory)');
  });
});
