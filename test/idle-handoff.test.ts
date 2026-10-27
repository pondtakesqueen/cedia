import { describe, expect, test } from 'bun:test';
import { COMPACT_INSTRUCTIONS } from '../src/core/project/compact.ts';
import { HANDOFF_PROMPT, resumeChoice } from '../src/core/project/handoff.ts';
import type { SessionEvent, Usage } from '../src/core/types.ts';
import { resolveModel } from '../src/core/providers/catalog.ts';

const model = resolveModel('anthropic/claude-haiku-5-5');
const usage = (tokens: number): Usage => ({ uncached: 0, cacheRead: tokens, cacheWrite: 0, output: 10 });
const at = (ms: number) => new Date(ms).toISOString();

// A session whose reply saw `tokens` of context, idle `idleMs` at `now`, on a 5-minute TTL.
const log = (idleMs: number, tokens: number, now = 1_000_000_000_000): SessionEvent[] => [
  { id: 'q', at: at(now - idleMs - 1000), kind: 'request', model: model.ref, toolsHash: 't', systemHash: 's', bodyHash: 'b', headers: {} },
  { id: 'a', at: at(now - idleMs), kind: 'assistant', wire: 'anthropic', model: model.ref, blocks: [{ type: 'text', text: 'x' }], stop: 'end_turn', usage: usage(tokens) },
] as unknown as SessionEvent[];

describe('idle handoff before cache expiry (2.1.299)', () => {
  test('a big session past 80% of its TTL goes fresh now instead of resuming into a certain miss', () => {
    const r = resumeChoice(log(250_000, 150_000), model, 12_000, new Date(1_000_000_000_000))!;
    expect(r).toMatchObject({ cold: false, stale: true, fresh: true });
  });

  test('a fresh-idle session still resumes, and a small stale one too', () => {
    expect(resumeChoice(log(60_000, 150_000), model, 12_000, new Date(1_000_000_000_000))).toMatchObject({ cold: false, stale: false, fresh: false });
    expect(resumeChoice(log(250_000, 20_000), model, 12_000, new Date(1_000_000_000_000))).toMatchObject({ stale: true, fresh: false });
  });
});

describe('handoff notes name the tools that worked (2.1.304)', () => {
  test('the note prompt and the compaction instructions ask for tool names', () => {
    expect(HANDOFF_PROMPT).toContain('The tools you called that worked');
    expect(COMPACT_INSTRUCTIONS).toContain('The tools called that the next steps still need');
  });
});
