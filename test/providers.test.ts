import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anthropicBody, anthropicProvider, EFFORT_BETA, parseAnthropic } from '../src/core/providers/anthropic.ts';
import { costUsd, deepseekOffPeak, FALLBACKS, resolveModel } from '../src/core/providers/catalog.ts';
import { chatBody, chatProvider, chatUsage, parseChat } from '../src/core/providers/chat.ts';
import { classifyStatus, isRetryable, USER_AGENT } from '../src/core/providers/http.ts';
import { parseResponses, responsesBody, responsesProvider } from '../src/core/providers/responses.ts';
import { readSse, streamFromString } from '../src/core/providers/sse.ts';
import type { Message, StreamEvent, WireRequest } from '../src/core/types.ts';

// Fixtures are written by hand from each API's documented stream format. Replace them with
// captured streams once the cache probe runs against real endpoints.
const fixture = (name: string) => streamFromString(readFileSync(join(import.meta.dir, 'fixtures/sse', name), 'utf8'), 13);

async function all(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const done = (evs: StreamEvent[]) => evs.find((e): e is Extract<StreamEvent, { type: 'done' }> => e.type === 'done');
const failure = (evs: StreamEvent[]) => evs.find((e): e is Extract<StreamEvent, { type: 'error' }> => e.type === 'error');

describe('sse reader', () => {
  test('handles split chunks, CRLF, comments and multi-line data', async () => {
    const raw = 'event: a\r\ndata: one\r\ndata: two\r\n\r\n: comment\n\ndata: {"x":1}\n\n';
    const msgs = [];
    for await (const m of readSse(streamFromString(raw, 3))) msgs.push(m);
    expect(msgs).toEqual([{ event: 'a', data: 'one\ntwo' }, { event: undefined, data: '{"x":1}' }]);
  });
});

describe('anthropic messages', () => {
  test('thinking with signature, text, two tool calls, usage', async () => {
    const evs = await all(parseAnthropic(fixture('anthropic-tools.sse')));
    const d = done(evs)!;
    expect(d.stop).toBe('tool_use');
    expect(d.blocks).toEqual([
      { type: 'thinking', text: 'Check the file.', opaque: 'sig-abc' },
      { type: 'text', text: 'Reading both.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'toolu_2', name: 'read', input: { path: 'b.txt' } },
    ]);
    expect(d.usage).toEqual({ uncached: 12, cacheRead: 4000, cacheWrite: 300, output: 57 });
    expect(evs.filter((e) => e.type === 'toolcall_delta')).toHaveLength(3);
  });

  test('max_tokens mid tool call marks the call as cut off', async () => {
    const d = done(await all(parseAnthropic(fixture('anthropic-length.sse'))))!;
    expect(d.stop).toBe('max_tokens');
    expect(d.blocks[0]).toMatchObject({ type: 'tool_use', inputError: 'tool call was cut off by the output limit' });
  });

  test('error mid stream becomes a retryable attempt error', async () => {
    const evs = await all(parseAnthropic(fixture('anthropic-error.sse')));
    expect(failure(evs)!.error.code).toBe('overloaded');
    expect(done(evs)).toBeUndefined();
  });
});

describe('chat completions', () => {
  test('reasoning, text, interleaved parallel tool calls, DeepSeek usage', async () => {
    const d = done(await all(parseChat(fixture('chat-tools.sse'))))!;
    expect(d.stop).toBe('tool_use');
    expect(d.blocks).toEqual([
      { type: 'thinking', text: 'Need two files.' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b.txt' } },
    ]);
    expect(d.usage).toEqual({ uncached: 400, cacheRead: 4600, cacheWrite: 0, output: 40, reasoning: 12 });
  });

  test('length stop truncates the tool call; OpenAI-style cached_tokens', async () => {
    const d = done(await all(parseChat(fixture('chat-length.sse'))))!;
    expect(d.stop).toBe('max_tokens');
    expect(d.blocks[0]).toMatchObject({ type: 'tool_use', id: 'call_x', inputError: 'tool call was cut off by the output limit' });
    expect(d.usage).toMatchObject({ uncached: 36, cacheRead: 64 });
  });

  test('error object in the stream', async () => {
    expect(failure(await all(parseChat(fixture('chat-error.sse'))))!.error.code).toBe('overloaded');
  });

  test('usage mapping prefers prompt_cache_hit_tokens', () => {
    expect(chatUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 6, prompt_tokens_details: { cached_tokens: 1 } })).toEqual({ uncached: 4, cacheRead: 6, cacheWrite: 0, output: 2 });
  });
});

describe('openai responses', () => {
  test('reasoning item kept opaque, text, function call with call_id, usage', async () => {
    const d = done(await all(parseResponses(fixture('responses-tools.sse'))))!;
    expect(d.stop).toBe('tool_use');
    const [thinking, txt, call] = d.blocks;
    expect(thinking).toMatchObject({ type: 'thinking', text: 'Look at a.' });
    expect(JSON.parse((thinking as { opaque: string }).opaque)).toMatchObject({ type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAAenc' });
    expect(txt).toEqual({ type: 'text', text: 'Reading a.' });
    expect(call).toEqual({ type: 'tool_use', id: 'fc_1', callId: 'call_r1', name: 'read', input: { path: 'a.txt' } });
    expect(d.usage).toEqual({ uncached: 808, cacheRead: 8192, cacheWrite: 0, output: 30, reasoning: 10 });
  });

  test('incomplete for max_output_tokens truncates the call', async () => {
    const d = done(await all(parseResponses(fixture('responses-length.sse'))))!;
    expect(d.stop).toBe('max_tokens');
    expect(d.blocks[0]).toMatchObject({ callId: 'call_r2', inputError: 'tool call was cut off by the output limit' });
  });

  test('response.failed', async () => {
    expect(failure(await all(parseResponses(fixture('responses-error.sse'))))!.error.code).toBe('server');
  });
});

const history: Message[] = [
  { role: 'user', parts: [{ type: 'text', text: 'read a' }] },
  {
    role: 'assistant',
    wire: 'anthropic-messages',
    blocks: [
      { type: 'thinking', text: 'hmm', opaque: 'sig' },
      { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
    ],
  },
  { role: 'user', parts: [{ type: 'tool_result', callId: 't1', text: 'alpha', isError: false }] },
  { role: 'system', text: 'note' },
];
const req = (ref: string, messages = history): WireRequest => ({
  model: resolveModel(ref),
  sessionId: 'sess-1',
  system: 'SYS',
  tools: [{ name: 'read', description: 'Read', schema: { type: 'object' } }],
  messages,
  effort: 'medium',
  maxTokens: 1000,
});

describe('request bodies', () => {
  test('anthropic: breakpoint on system plus automatic caching, thinking replayed only to its own wire', () => {
    const b = anthropicBody(req('opus')) as any;
    expect(b.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(b.cache_control).toEqual({ type: 'ephemeral' });
    expect(b.output_config).toEqual({ effort: 'medium' });
    expect(b.speed).toBeUndefined();
    const fast = resolveModel('opus-fast');
    expect(anthropicBody(req('opus-fast')) as any).toMatchObject({ model: 'claude-opus-5-5', speed: 'fast' });
    expect(fast.headers).toEqual({ 'anthropic-beta': 'fast-mode-2026-02-01' });
    expect(fast.price.output).toBe(2 * resolveModel('opus').price.output);
    expect(b.messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'hmm', signature: 'sig' });
    // The mid-conversation note becomes a reminder in the same user turn as the tool result.
    expect(b.messages[2].content.map((c: any) => c.type)).toEqual(['tool_result', 'text']);

    const foreign = history.map((m) => (m.role === 'assistant' ? { ...m, wire: 'chat-completions' as const } : m));
    const f = anthropicBody(req('opus', foreign)) as any;
    expect(f.messages[1].content.map((c: any) => c.type)).toEqual(['tool_use']);
  });

  test('anthropic: a per-message effort change is an empty system message, sent with its beta header', () => {
    const raised: Message[] = [...history, { role: 'effort', effort: 'high' }];
    const b = anthropicBody(req('opus', raised)) as any;
    // Everything before it is unchanged, and the top-level effort stays, so the cached prefix still matches.
    expect(b.messages.slice(0, -1)).toEqual((anthropicBody(req('opus')) as any).messages);
    expect(b.messages.at(-1)).toEqual({ role: 'system', content: [], output_config: { effort: 'high' } });
    expect(b.output_config).toEqual({ effort: 'medium' });
    const p = anthropicProvider();
    expect(p.headers(req('opus'))['anthropic-beta']).toBeUndefined();
    expect(p.headers(req('opus', raised))['anthropic-beta']).toBe(EFFORT_BETA);
    expect(p.headers(req('opus-fast', raised))['anthropic-beta']).toBe(`fast-mode-2026-02-01,${EFFORT_BETA}`);
    // Other wires have no such message and drop it.
    expect((chatBody(req('deepseek', raised)) as any).messages).toEqual((chatBody(req('deepseek')) as any).messages);
    expect((responsesBody(req('grok', raised)) as any).input).toEqual((responsesBody(req('grok')) as any).input);
  });

  test('chat: tool messages, system role mid-conversation, reasoning only from its own wire', () => {
    const b = chatBody(req('deepseek')) as any;
    expect(b.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'system']);
    expect(b.messages[2].tool_calls[0]).toEqual({ id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } });
    expect(b.messages[2].reasoning_content).toBeUndefined();
    const own = history.map((m) => (m.role === 'assistant' ? { ...m, wire: 'chat-completions' as const } : m));
    expect((chatBody(req('deepseek', own)) as any).messages[2].reasoning_content).toBe('hmm');
    // A tool-call turn with no reasoning still carries the field: DeepSeek's thinking mode rejects it missing.
    const noThinking = own.map((m) => (m.role === 'assistant' ? { ...m, blocks: m.blocks.filter((b) => b.type !== 'thinking') } : m));
    expect((chatBody(req('deepseek', noThinking)) as any).messages[2].reasoning_content).toBe('');
    expect(b.stream_options).toEqual({ include_usage: true });
  });

  test('responses: prompt_cache_key, function_call_output, encrypted reasoning', () => {
    const b = responsesBody(req('grok')) as any;
    expect(b.prompt_cache_key).toBe('sess-1');
    expect(b.store).toBe(false);
    expect(b.include).toEqual(['reasoning.encrypted_content']);
    expect(b.input.map((i: any) => i.type ?? i.role)).toEqual(['user', 'function_call', 'function_call_output', 'developer']);
  });
});

describe('anthropic keep-alive', () => {
  test('sends the same body with max_tokens 0 and no stream, to the same place, and reads the usage', async () => {
    const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ content: [], stop_reason: 'max_tokens', usage: { input_tokens: 3, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 0 } }));
    };
    process.env.OPENCODE_API_KEY = 'test-key';
    const p = anthropicProvider(fetcher);
    const r = await p.keepAlive!(req('haiku'), new AbortController().signal);
    expect(r).toEqual({ ok: true, usage: { uncached: 3, cacheRead: 9000, cacheWrite: 0, output: 0 } });
    const { max_tokens, stream, ...rest } = seen[0]!.body;
    expect([max_tokens, stream]).toEqual([0, false]);
    const { max_tokens: _, stream: __, ...same } = anthropicBody(req('haiku')) as any;
    expect(rest).toEqual(same);
    expect(seen[0]!.url).toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(seen[0]!.headers['x-opencode-session']).toBe('sess-1');
    const failing = anthropicProvider(async () => new Response('{"error":{"type":"overloaded_error"}}', { status: 529 }));
    expect(await failing.keepAlive!(req('haiku'), new AbortController().signal)).toMatchObject({ ok: false });
  });
});

describe('http', () => {
  test('Go requests carry x-opencode-session, our User-Agent and bearer auth', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(readFileSync(join(import.meta.dir, 'fixtures/sse/chat-length.sse')));
    };
    process.env.OPENCODE_API_KEY = 'test-key';
    await all(chatProvider(fetcher).stream(req('deepseek'), new AbortController().signal));
    await all(anthropicProvider(fetcher).stream(req('haiku'), new AbortController().signal));
    await all(responsesProvider(fetcher).stream(req('grok'), new AbortController().signal));
    expect(seen.map((s) => s.url)).toEqual([
      'https://opencode.ai/inference/go/openai/v1/chat/completions',
      'https://opencode.ai/inference/go/anthropic/v1/messages',
      'https://opencode.ai/inference/go/openai/v1/responses',
    ]);
    for (const s of seen) {
      expect(s.headers['x-opencode-session']).toBe('sess-1');
      expect(s.headers['user-agent']).toBe(USER_AGENT);
      expect(s.headers['user-agent']).not.toMatch(/claude|codex|opencode/i);
      expect(s.headers.authorization).toBe('Bearer test-key');
    }
  });

  test('status codes map to the error taxonomy', () => {
    expect(classifyStatus(429, '', '2')).toMatchObject({ code: 'rate_limit', retryAfterMs: 2000 });
    expect(classifyStatus(529, '').code).toBe('overloaded');
    expect(classifyStatus(401, '').code).toBe('auth');
    expect(classifyStatus(400, 'prompt is too long: 1200000 tokens').code).toBe('context_length');
    expect(classifyStatus(400, 'bad').code).toBe('bad_request');
    expect(classifyStatus(503, '').code).toBe('server');
    // A spent plan or balance is not a per-minute limit: it never retries, and a fallback may pick the task up.
    expect(classifyStatus(402, '{"error":{"message":"Insufficient Balance"}}').code).toBe('quota');
    expect(classifyStatus(429, '{"error":{"message":"You have reached your usage limit for this period"}}').code).toBe('quota');
    expect(classifyStatus(429, 'slow down').code).toBe('rate_limit');
    expect(classifyStatus(429, '{"error":{"message":"Rate limit exceeded. Please try again later."}}', '27380').code).toBe('quota');
    expect(classifyStatus(429, 'slow down', '600').code).toBe('rate_limit');
    expect(isRetryable(classifyStatus(402, ''))).toBe(false);
  });

  test("DeepSeek's own API counts as training on prompts; the quota fallback is Haiku on the Claude API", () => {
    const api = resolveModel('deepseek-api');
    expect(api).toMatchObject({ id: 'deepseek-v4.1-flash', url: 'https://api.deepseek.com/chat/completions', dataPolicy: 'trains', auth: { env: 'DEEPSEEK_API_KEY' } });
    expect(api.price).toEqual(resolveModel('deepseek').price);
    const fallback = resolveModel(FALLBACKS[resolveModel('deepseek').ref]!);
    expect(fallback).toMatchObject({ ref: 'anthropic/claude-haiku-5-5', url: 'https://api.anthropic.com/v1/messages', dataPolicy: 'retained' });
  });
});

describe('cost', () => {
  test('DeepSeek off-peak and Haiku long-context tiers', () => {
    const ds = resolveModel('deepseek');
    const u = { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };
    expect(deepseekOffPeak(new Date('2026-10-21T02:00:00Z'))).toBe(false); // Wednesday, peak
    expect(costUsd(ds, u, new Date('2026-10-21T02:00:00Z'))).toBeCloseTo(0.3);
    expect(costUsd(ds, u, new Date('2026-10-21T12:00:00Z'))).toBeCloseTo(0.15);
    expect(costUsd(ds, u, new Date('2026-10-24T02:00:00Z'))).toBeCloseTo(0.15); // Saturday
    const haiku = resolveModel('haiku');
    expect(costUsd(haiku, { uncached: 50_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeCloseTo(0.005);
    expect(costUsd(haiku, { uncached: 200_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeCloseTo(0.1);
  });
});
