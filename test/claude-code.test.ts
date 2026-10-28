import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeEnv, runClaudeCode, startClaudeCode } from '../src/clients/headless/claude-code.ts';

const fake = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-cc-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dir, bin };
};
const step = { model: 'opus', effort: 'medium', cwd: tmpdir(), allowed: ['Read'] };
const result = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1', num_turns: 2, duration_api_ms: 900 });

test('a step started ahead of its prompt spends its start-up before the prompt comes', async () => {
  // A Claude Code that takes 400 ms to start, then answers at once with the prompt it read.
  const { bin } = fake(`sleep 0.4\nread -r line\necho '{"type":"system","subtype":"init"}'\nprintf '%s\\n' '${result('ok')}'`);
  const warm = startClaudeCode(step, bin);
  await Bun.sleep(600); // the triage, or the writer
  const t0 = Date.now();
  const r = await warm.run('plan this');
  expect(Date.now() - t0).toBeLessThan(300);
  expect(r).toEqual({ ok: true, text: 'ok', sessionId: 's1', turns: 2, apiMs: 900 });
  // Cold, the same step pays the start-up after the prompt.
  const t1 = Date.now();
  expect((await runClaudeCode({ ...step, prompt: 'plan this' }, bin)).ok).toBe(true);
  expect(Date.now() - t1).toBeGreaterThanOrEqual(400);
});

test('the prompt goes in on stdin as one stream-json user message', async () => {
  const { dir, bin } = fake(`cat > "$(dirname "$0")/stdin"\nprintf '%s\\n' '${result('ok')}'`);
  await runClaudeCode({ ...step, prompt: 'line one\nline "two"' }, bin);
  const sent = (await Bun.file(join(dir, 'stdin')).text()).trim().split('\n');
  expect(sent.length).toBe(1);
  expect(JSON.parse(sent[0]!)).toEqual({ type: 'user', message: { role: 'user', content: 'line one\nline "two"' } });
});

test('a cancelled step never gets its prompt, and runs at most once', async () => {
  const { dir, bin } = fake(`read -r line && echo "$line" > "$(dirname "$0")/got"\nprintf '%s\\n' '${result('ok')}'`);
  const warm = startClaudeCode(step, bin);
  warm.cancel();
  expect((await warm.run('x')).ok).toBe(false);
  await Bun.sleep(100);
  expect(await Bun.file(join(dir, 'got')).exists()).toBe(false);
});

test('a Claude Code that exits before its prompt, or prints no result, is a failed step with its output', async () => {
  const early = startClaudeCode(step, fake(`echo 'not logged in' >&2\nexit 1`).bin);
  await Bun.sleep(200);
  expect(await early.run('x')).toMatchObject({ ok: false, error: expect.stringContaining('not logged in') });
  expect(await runClaudeCode({ ...step, prompt: 'x' }, '/nonexistent/claude')).toMatchObject({ ok: false, error: expect.stringContaining('could not start') });
});

test('the review goes without the git status Claude Code takes at start; keys that bill the API never pass', () => {
  const from = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', CEDIA_HOME: '/h' };
  expect(claudeCodeEnv({}, from)).toEqual({ PATH: '/bin' });
  expect(claudeCodeEnv({ gitStatus: false }, from)).toEqual({ PATH: '/bin', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' });
});
