import { expect, test } from 'bun:test';
import { anthropicBody } from '../src/core/providers/anthropic.ts';
import { resolveModel } from '../src/core/providers/catalog.ts';
import type { WireRequest } from '../src/core/types.ts';

const request = (ref: string): WireRequest => ({ model: resolveModel(ref), system: 's', tools: [], messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], maxTokens: 100, sessionId: 's1' }) as WireRequest;

test('Claude models on the Anthropic API ask for summarized thinking, so a client has something to show', () => {
  for (const ref of ['anthropic/claude-haiku-5-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-fable-5-1', 'anthropic/claude-opus-5-5-fast'])
    expect((anthropicBody(request(ref)) as any).thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  // OpenCode Go's gateway was not tried with it.
  expect((anthropicBody(request('opencode-go/claude-haiku-5-5')) as any).thinking).toBeUndefined();
});
