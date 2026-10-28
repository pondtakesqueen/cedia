import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSuggestion } from '../src/core/suggestions/prompt-suggestion.ts';

const realFetch = globalThis.fetch;
const env = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...env };
});

// The suggestion sends the last reply to a model that keeps prompts; under zdr it must not leave the machine.
test('a prompt suggestion honours the zdr privacy level', async () => {
  process.env.CEDIA_HOME = mkdtempSync(join(tmpdir(), 'cedia-sug-'));
  process.env.OPENCODE_API_KEY = 'test';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{}', { status: 400 });
  }) as unknown as typeof fetch;
  process.env.CEDIA_PRIVACY = 'zdr';
  expect(await generateSuggestion({ cwd: process.env.CEDIA_HOME, model: 'beam', lastResult: 'the code' })).toBeNull();
  expect(calls).toBe(0);
  process.env.CEDIA_PRIVACY = 'no-training';
  await generateSuggestion({ cwd: process.env.CEDIA_HOME, model: 'beam', lastResult: 'the code' });
  expect(calls).toBeGreaterThan(0);
}, 60_000);
