import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectKey } from '../src/core/session/log.ts';
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

// A suggestion is a model request like any other: its session is on disk, so `cedia usage` counts it.
test('a prompt suggestion is logged as a suggest session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cedia-sug-log-'));
  process.env.CEDIA_HOME = home;
  const script = join(home, 'script.json');
  writeFileSync(script, JSON.stringify([{ blocks: [{ type: 'text', text: 'run the tests' }] }]));
  process.env.CEDIA_FAUX_SCRIPT = script;
  expect(await generateSuggestion({ cwd: home, model: 'faux', lastResult: 'the code' })).toEqual({ text: 'run the tests' });
  const dir = join(home, 'sessions', projectKey(home));
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, files[0]!), 'utf8').split('\n')[0]!)).toMatchObject({ kind: 'session', role: 'suggest' });
});
