import { EFFORTS, type ModelCapabilities, type ModelSpec, type Price, type Usage } from '../types.ts';

// Prices are USD per 1M tokens: Anthropic from the Claude API model catalog, OpenCode Go from its docs
// (console/go.mdx, read 2026-10-21). Context windows for Go models are DeepSeek harness defaults;
// refresh them from https://opencode.ai/inference/go/v1/models when they matter.

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
// Claude Code cloud sessions drop ANTHROPIC_API_KEY from the environment, so cedia also reads CEDIA_ANTHROPIC_API_KEY.
const ANTHROPIC_AUTH = { env: 'ANTHROPIC_API_KEY', altEnv: 'CEDIA_ANTHROPIC_API_KEY', scheme: 'x-api-key' } as const;
const GO = 'https://opencode.ai/inference/go';
const GO_AUTH = { env: 'OPENCODE_API_KEY', scheme: 'bearer' } as const;
const DEEPSEEK = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_AUTH = { env: 'DEEPSEEK_API_KEY', scheme: 'bearer' } as const;
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_AUTH = { env: 'OPENROUTER_API_KEY', scheme: 'bearer' } as const;

const claudeCaps: ModelCapabilities = {
  reasoning: 'anthropic-thinking',
  replayReasoning: 'required',
  parallelToolCalls: true,
  input: ['text', 'image'],
  effortLevels: EFFORTS,
  cacheMinTokens: 512,
  cacheBlockTokens: 16, // reads land a few tokens short of the previous input (turn boundary re-render), measured on Haiku 5.5 via Go
  midConversationSystem: false,
  // Beta on every 5.5 model and Fable 5.1, through OpenCode Go too (tried 2026-10-22).
  midConversationEffort: true,
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
  midConversationEffort: false,
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
  // OpenCode Go passes the compaction field on but not its beta header (probed 2026-10-22), so only here.
  compaction: true,
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

// DeepSeek V4.1 Flash's own lines. Against Claude Code on hard-pool (2026-10-22) it took 12 to 14 turns to
// Claude's 5: it wrote test files of its own and then fixed them, ran the tests five times in a loop to look for
// flakiness, and spent a call on each ls, cat and grep. Each rule says why, in cedia's own words.
const DEEPSEEK_PROMPT = `For this model in particular:
- Do not create test files of your own. When the task needs a new case, add it to the test file that already covers that code, in the same edit as the fix. A new file is one more thing to run, read and fix.
- Run a check once after your last change. A pass is the evidence; running it again in a loop to look for flakiness proves nothing new and costs a turn each time.
- Put independent shell steps in one bash call (\`ls src && cat package.json && grep -n foo src/a.ts\`) instead of one call each.`;

const deepseekFlashPrice = { ...p(0.3, 1.2, 0.006), offPeak: { ...p(0.15, 0.6, 0.003), isOffPeak: deepseekOffPeak } };
const haikuPrice = { ...p(0.1, 0.5, 0.01, 0.125), above: { tokens: 100_000, price: p(0.5, 2.5, 0.05, 0.625) } };

export const CATALOG: ModelSpec[] = [
  claude('claude-fable-5-1', p(10, 50, 0.25, 12.5)),
  claude('claude-opus-5-5', p(4, 20, 0.2, 5)),
  // Fast mode (research preview, Claude API only): up to 2.5x output tokens per second at 2x the price.
  claude('claude-opus-5-5', p(8, 40, 0.4, 10), { ref: 'anthropic/claude-opus-5-5-fast', speed: 'fast', headers: { 'anthropic-beta': 'fast-mode-2026-02-01' } }),
  claude('claude-sonnet-5-5', p(2, 10, 0.2, 2.5), { defaultEffort: 'high' }),
  // Haiku starts at low and escalates to high when the done gate refuses a claim: on the gate suite that kept
  // 48/48 and cost 21% less for the typical task than medium (2026-10-22, evals/gate/README.md).
  claude('claude-haiku-5-5', haikuPrice, { defaultEffort: 'low' }),
  go('claude-haiku-5-5', 'anthropic-messages', haikuPrice, { maxOutput: 128_000, dataPolicy: 'retained', defaultEffort: 'low' }),
  go('deepseek-v4.1-flash', 'chat-completions', deepseekFlashPrice, { prompt: DEEPSEEK_PROMPT }),
  go('deepseek-v4-pro', 'chat-completions', { ...p(1.32, 3.96, 0.044), offPeak: { ...p(0.66, 1.98, 0.022), isOffPeak: deepseekOffPeak } }),
  go('beam-free', 'chat-completions', p(0, 0, 0), { dataPolicy: 'retained' }),
  go('muse-spark-1.3-contributor', 'openai-responses', p(0.1, 0.2, 0.002), { dataPolicy: 'trains' }),
  go('grok-4.7', 'openai-responses', { ...p(2, 6, 0.5), above: { tokens: 200_000, price: p(4, 12, 1) } }, { dataPolicy: 'retained', caps: { ...responsesCaps, effortLevels: ['low', 'medium', 'high', 'xhigh'] } }),
  // DeepSeek's own API, paid per token. Its privacy policy lists training as a use of inputs with no opt-out for
  // the API, so it counts as `trains` and runs only in public repos.
  {
    ref: 'deepseek/deepseek-v4.1-flash',
    id: 'deepseek-v4.1-flash',
    wire: 'chat-completions',
    url: DEEPSEEK,
    auth: DEEPSEEK_AUTH,
    maxOutput: 32_000,
    price: deepseekFlashPrice,
    dataPolicy: 'trains',
    prompt: DEEPSEEK_PROMPT,
    caps: chatCaps,
  },
  // The same model through OpenRouter, paid per token. OpenRouter serves it from about 30 endpoints with caches
  // of their own, so a session left to its routing moved between them and read 24.5% from cache (hard-pool,
  // 2026-10-22). It is pinned to Cloudflare's: on OpenRouter's list of zero-retention endpoints, not quantized
  // to fp4, and 91.8% cache hits on the same task ($0.10/$0.60 per 1M, cache read $0.003, from the endpoint list).
  // No fallback to another endpoint: one that is down fails the request, and the quota fallback takes over.
  {
    ref: 'openrouter/deepseek-v4.1-flash',
    id: 'deepseek/deepseek-v4.1-flash-1017',
    wire: 'chat-completions',
    url: OPENROUTER,
    auth: OPENROUTER_AUTH,
    maxOutput: 32_000,
    price: p(0.1, 0.6, 0.003),
    dataPolicy: 'zdr',
    body: { provider: { order: ['cloudflare'], allow_fallbacks: false, zdr: true, data_collection: 'deny' } },
    prompt: DEEPSEEK_PROMPT,
    caps: chatCaps,
  },
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
  compaction: true,
  caps: { ...chatCaps, contextWindow: 200_000 },
};

// A second scripted model, so tests can follow a fallback offline. It reads the same script as faux.
export const FAUX_FALLBACK: ModelSpec = { ...FAUX_MODEL, ref: 'faux/fallback', id: 'fallback' };

export const ALIASES: Record<string, string> = {
  opus: 'anthropic/claude-opus-5-5',
  'opus-fast': 'anthropic/claude-opus-5-5-fast',
  fable: 'anthropic/claude-fable-5-1',
  sonnet: 'anthropic/claude-sonnet-5-5',
  haiku: 'opencode-go/claude-haiku-5-5',
  deepseek: 'opencode-go/deepseek-v4.1-flash',
  'deepseek-api': 'deepseek/deepseek-v4.1-flash',
  'deepseek-or': 'openrouter/deepseek-v4.1-flash',
  'deepseek-pro': 'opencode-go/deepseek-v4-pro',
  beam: 'opencode-go/beam-free',
  muse: 'opencode-go/muse-spark-1.3-contributor',
  grok: 'opencode-go/grok-4.7',
  faux: 'faux/scripted',
};

// Where a session goes when its model's plan or balance runs out. Off the Go plan, so its quota does not apply,
// and kept from training: Haiku 5.5 on the Claude API passed as many hard evals as Go's DeepSeek Flash for less.
export const FALLBACKS: Record<string, string> = {
  'opencode-go/deepseek-v4.1-flash': 'anthropic/claude-haiku-5-5',
  'openrouter/deepseek-v4.1-flash': 'anthropic/claude-haiku-5-5',
};

export function resolveModel(ref: string): ModelSpec {
  const full = ALIASES[ref] ?? ref;
  if (full === FAUX_MODEL.ref) return FAUX_MODEL;
  if (full === FAUX_FALLBACK.ref) return FAUX_FALLBACK;
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
