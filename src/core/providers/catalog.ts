import type { Effort, ModelCapabilities, ModelSpec, Price, Usage } from '../types.ts';

// Prices are USD per 1M tokens: Anthropic from the Claude API model catalog, OpenCode Go from its docs
// (console/go.mdx, read 2026-10-21). Context windows for Go models are DeepSeek harness defaults;
// refresh them from https://opencode.ai/inference/go/v1/models when they matter.

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
// Claude Code cloud sessions drop ANTHROPIC_API_KEY from the environment, so cedia also reads CEDIA_ANTHROPIC_API_KEY.
const ANTHROPIC_AUTH = { env: 'ANTHROPIC_API_KEY', altEnv: 'CEDIA_ANTHROPIC_API_KEY', scheme: 'x-api-key' } as const;
const GO = 'https://opencode.ai/inference/go';
const GO_AUTH = { env: 'OPENCODE_API_KEY', scheme: 'bearer' } as const;
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const claudeCaps: ModelCapabilities = {
  reasoning: 'anthropic-thinking',
  replayReasoning: 'required',
  parallelToolCalls: true,
  input: ['text', 'image'],
  effortLevels: EFFORTS,
  cacheMinTokens: 512,
  cacheBlockTokens: 16, // reads land a few tokens short of the previous input (turn boundary re-render), measured on Haiku 5.5 via Go
  midConversationSystem: false,
  contextWindow: 1_000_000,
};

const chatCaps: ModelCapabilities = {
  reasoning: 'reasoning_content',
  replayReasoning: 'same-turn',
  parallelToolCalls: true,
  input: ['text'],
  effortLevels: [],
  cacheMinTokens: 64,
  cacheBlockTokens: 128, // measured on DeepSeek V4.1 Flash via Go, 2026-10-21
  midConversationSystem: true,
  contextWindow: 1_000_000,
};

const responsesCaps: ModelCapabilities = { ...chatCaps, reasoning: 'responses-item', replayReasoning: 'required', midConversationSystem: true, effortLevels: ['low', 'medium', 'high'] };

const p = (input: number, output: number, cacheRead: number, cacheWrite = 0): Price => ({ input, output, cacheRead, cacheWrite });

// DeepSeek peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
export function deepseekOffPeak(d: Date): boolean {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return true;
  const h = d.getUTCHours();
  return !((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

const claude = (id: string, price: Price, extra: Partial<ModelSpec> = {}): ModelSpec => ({
  ref: `anthropic/${id}`,
  id,
  wire: 'anthropic-messages',
  url: ANTHROPIC,
  auth: ANTHROPIC_AUTH,
  maxOutput: 128_000,
  defaultEffort: 'medium',
  price,
  dataPolicy: 'retained',
  caps: claudeCaps,
  ...extra,
});

const go = (id: string, wire: ModelSpec['wire'], price: ModelSpec['price'], extra: Partial<ModelSpec> = {}): ModelSpec => ({
  ref: `opencode-go/${id}`,
  id,
  wire,
  url: wire === 'anthropic-messages' ? `${GO}/anthropic/v1/messages` : wire === 'openai-responses' ? `${GO}/openai/v1/responses` : `${GO}/openai/v1/chat/completions`,
  auth: GO_AUTH,
  sessionHeader: 'x-opencode-session',
  maxOutput: 32_000,
  price,
  dataPolicy: 'zdr',
  caps: wire === 'anthropic-messages' ? claudeCaps : wire === 'openai-responses' ? responsesCaps : chatCaps,
  ...(wire === 'openai-responses' ? { cacheKeyField: 'prompt_cache_key' as const } : {}),
  ...extra,
});

const haikuPrice = { ...p(0.1, 0.5, 0.01, 0.125), above: { tokens: 100_000, price: p(0.5, 2.5, 0.05, 0.625) } };

export const CATALOG: ModelSpec[] = [
  claude('claude-fable-5-1', p(10, 50, 0.25, 12.5)),
  claude('claude-opus-5-5', p(4, 20, 0.2, 5)),
  // Fast mode (research preview, Claude API only): up to 2.5x output tokens per second at 2x the price.
  claude('claude-opus-5-5', p(8, 40, 0.4, 10), { ref: 'anthropic/claude-opus-5-5-fast', speed: 'fast', headers: { 'anthropic-beta': 'fast-mode-2026-02-01' } }),
  claude('claude-sonnet-5-5', p(2, 10, 0.2, 2.5), { defaultEffort: 'high' }),
  claude('claude-haiku-5-5', haikuPrice),
  go('claude-haiku-5-5', 'anthropic-messages', haikuPrice, { maxOutput: 128_000, dataPolicy: 'retained', defaultEffort: 'medium' }),
  go('deepseek-v4.1-flash', 'chat-completions', { ...p(0.3, 1.2, 0.006), offPeak: { ...p(0.15, 0.6, 0.003), isOffPeak: deepseekOffPeak } }),
  go('deepseek-v4-pro', 'chat-completions', { ...p(1.32, 3.96, 0.044), offPeak: { ...p(0.66, 1.98, 0.022), isOffPeak: deepseekOffPeak } }),
  go('beam-free', 'chat-completions', p(0, 0, 0), { dataPolicy: 'retained' }),
  go('muse-spark-1.3-contributor', 'openai-responses', p(0.1, 0.2, 0.002), { dataPolicy: 'trains' }),
  go('grok-4.7', 'openai-responses', { ...p(2, 6, 0.5), above: { tokens: 200_000, price: p(4, 12, 1) } }, { dataPolicy: 'retained', caps: { ...responsesCaps, effortLevels: ['low', 'medium', 'high', 'xhigh'] } }),
];

export const FAUX_MODEL: ModelSpec = {
  ref: 'faux/scripted',
  id: 'scripted',
  wire: 'faux',
  url: 'faux://',
  auth: { env: 'CEDIA_FAUX_KEY', scheme: 'bearer' },
  sessionHeader: 'x-opencode-session',
  maxOutput: 8_000,
  price: p(1, 2, 0.1, 1.25),
  dataPolicy: 'zdr',
  caps: { ...chatCaps, contextWindow: 200_000 },
};

export const ALIASES: Record<string, string> = {
  opus: 'anthropic/claude-opus-5-5',
  'opus-fast': 'anthropic/claude-opus-5-5-fast',
  fable: 'anthropic/claude-fable-5-1',
  sonnet: 'anthropic/claude-sonnet-5-5',
  haiku: 'opencode-go/claude-haiku-5-5',
  deepseek: 'opencode-go/deepseek-v4.1-flash',
  'deepseek-pro': 'opencode-go/deepseek-v4-pro',
  beam: 'opencode-go/beam-free',
  muse: 'opencode-go/muse-spark-1.3-contributor',
  grok: 'opencode-go/grok-4.7',
  faux: 'faux/scripted',
};

export function resolveModel(ref: string): ModelSpec {
  const full = ALIASES[ref] ?? ref;
  if (full === FAUX_MODEL.ref) return FAUX_MODEL;
  const m = CATALOG.find((c) => c.ref === full);
  if (!m) throw new Error(`unknown model "${ref}". Known: ${[...Object.keys(ALIASES), ...CATALOG.map((c) => c.ref)].join(', ')}`);
  return m;
}

export function priceFor(model: ModelSpec, usage: Usage, at: Date): Price {
  const input = usage.uncached + usage.cacheRead + usage.cacheWrite;
  if (model.price.above && input > model.price.above.tokens) return model.price.above.price;
  if (model.price.offPeak?.isOffPeak(at)) return model.price.offPeak;
  return model.price;
}

export function costUsd(model: ModelSpec, usage: Usage, at = new Date()): number {
  const pr = priceFor(model, usage, at);
  return (usage.uncached * pr.input + usage.cacheRead * pr.cacheRead + usage.cacheWrite * pr.cacheWrite + usage.output * pr.output) / 1_000_000;
}
