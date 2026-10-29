import { EFFORTS, type ModelCapabilities, type ModelSpec, type Price, type Usage } from '../types.ts';
import { cediaHome, readSettings } from '../config.ts';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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
// OpenRouter's Anthropic Messages endpoint: the same body as the Claude API, cache_control and usage fields included.
const OPENROUTER_MESSAGES = 'https://openrouter.ai/api/v1/messages';
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
// flakiness, and spent a call on each ls, cat and grep. On hard-csv-stream and hard-memo-async (2026-10-23) it
// took 6 to 16 turns to Claude's 3 to 5: 1 to 8 of them after the tests first passed, on fuzz, timing and mutation
// scripts of its own that found nothing (one ran 156 s and the run timed out before reporting), and it built a
// new class up over five edits where Claude wrote it in one. The last three lines take the idea of ponytail's
// ladder (MIT, github.com/dietrichgebert/ponytail): with its ruleset added, the gate took 18% fewer turns and the
// typical task 11% less cost and 23% less time, and a streaming parser came out 18% shorter (2026-10-23). Each
// rule says why, in cedia's own words.
const DEEPSEEK_PROMPT = `For this model in particular:
- Do not create test files of your own. When the task needs a new case, add it to the test file that already covers that code, in the same edit as the fix. A new file is one more thing to run, read and fix.
- Run a check once after your last change. A pass is the evidence; running it again in a loop to look for flakiness proves nothing new and costs a turn each time.
- Put independent shell steps in one bash call (\`ls src && cat package.json && grep -n foo src/a.ts\`) instead of one call each.
- Once the checks pass after your last change, report. Do not write fuzz, timing or mutation scripts of your own to test the change further: they ran for minutes and changed nothing in every run that tried, and a run that is still checking when its time runs out reports nothing.
- Make the changes a file needs in as few edits as you can: write a new function whole in one edit rather than building it up over several.
- Before writing new code, take the first of these that does the job: nothing, when the task does not need it; code the repository already has; the standard library or the platform; a dependency already installed; one line. Only then write the smallest new code that works. Shorter code is never a reason to drop input checks, error handling that keeps data safe, or security checks.
- When new logic branches, loops, parses, or handles money or security, add a test of it to the test file that covers that code, in the same edit.
- End your report with one line on what you left out or did not check.`;

// Opus 5.5 writing alone lost 8 of 19 blind pairs to Claude Code on Opus and won 1 (2026-10-28): it stopped at a
// passing check and missed rules no visible test held (failure paths, doc-comment rules, old behaviour kept). With
// these lines, on the 7 tasks it lost, it won 2, tied 1 and lost 4, correctness went from -1.14 to +0.29 against
// Claude Code, and it still cost 35% less on the 6 tasks both arms finished (research/NOTES.md).
const OPUS_PROMPT = `For this model in particular, correctness comes before brevity:
- Every rule in the task and in the doc comments of the code you change is a requirement, including the ones no visible test checks. Where you rewrite code, keep every behaviour of the old code that the task does not ask to change, odd inputs and error messages included.
- Do not change a documented rule to make a case pass. If the doc and a case disagree, follow the doc and say so in the report.
- Walk the failure paths of what you write before you finish: state after a thrown error, a caller that stops early or aborts (streams, listeners, timers and handles released), entries that expire or are removed, a callback that throws synchronously, and inputs at each boundary.
- When you add or change tests, cover each behaviour you changed with a deterministic case (no wall-clock bounds or sleeps), boundaries included.`;

const deepseekFlashPrice = { ...p(0.3, 1.2, 0.006), offPeak: { ...p(0.15, 0.6, 0.003), isOffPeak: deepseekOffPeak } };
const haikuPrice = { ...p(0.1, 0.5, 0.01, 0.125), above: { tokens: 100_000, price: p(0.5, 2.5, 0.05, 0.625) } };

export const CATALOG: ModelSpec[] = [
  claude('claude-fable-5-1', p(10, 50, 0.25, 12.5)),
  claude('claude-opus-5-5', p(4, 20, 0.2, 5), { prompt: OPUS_PROMPT, thorough: true }),
  // Fast mode (research preview, Claude API only): up to 2.5x output tokens per second at 2x the price.
  claude('claude-opus-5-5', p(8, 40, 0.4, 10), { ref: 'anthropic/claude-opus-5-5-fast', speed: 'fast', prompt: OPUS_PROMPT, thorough: true, headers: { 'anthropic-beta': 'fast-mode-2026-02-01' } }),
  claude('claude-sonnet-5-5', p(2, 10, 0.1, 2.5), { defaultEffort: 'high' }),
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
  // DeepInfra's fp8 endpoint is second, also zero-retention and cheaper ($0.098/$0.294, 95.7% cache hits on
  // hard-pool): OpenRouter goes to it only when Cloudflare refuses a request, which a 429 from Cloudflare's shared
  // upstream pool did part way through a split-plan run (2026-10-23). No endpoint outside the two.
  {
    ref: 'openrouter/deepseek-v4.1-flash',
    id: 'deepseek/deepseek-v4.1-flash-1017',
    wire: 'chat-completions',
    url: OPENROUTER,
    auth: OPENROUTER_AUTH,
    maxOutput: 32_000,
    price: p(0.1, 0.6, 0.003),
    dataPolicy: 'zdr',
    body: { provider: { order: ['cloudflare', 'deepinfra/fp8'], allow_fallbacks: false, zdr: true, data_collection: 'deny' } },
    prompt: DEEPSEEK_PROMPT,
    caps: chatCaps,
  },
  // Haiku 5.5 through OpenRouter's Messages endpoint, so a run on it takes the same wire as on the Claude API or Go
  // and the harnesses can be compared on one model. OpenRouter's zero-retention endpoints for it are Google Vertex
  // and Amazon Bedrock (Anthropic's own is not on that list, 2026-10-23). Probed on a growing conversation
  // (2026-10-23): Vertex missed about one request in four at 2-3k tokens and rewrote the whole prefix; Bedrock never
  // missed but did not move the top-level breakpoint past the system prompt, so it carries one on the newest block.
  {
    ref: 'openrouter/claude-haiku-5-5',
    id: 'anthropic/claude-haiku-5.5',
    wire: 'anthropic-messages',
    url: OPENROUTER_MESSAGES,
    auth: OPENROUTER_AUTH,
    maxOutput: 64_000,
    defaultEffort: 'low',
    price: haikuPrice,
    dataPolicy: 'zdr',
    body: { provider: { order: ['amazon-bedrock'], allow_fallbacks: false, zdr: true, data_collection: 'deny' } },
    cacheTail: true,
    caps: claudeCaps,
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
// A scripted model that reads images, which a faux run with images goes to (config.ts loadMedia), so tests follow
// the media route offline.
export const FAUX_MEDIA: ModelSpec = { ...FAUX_MODEL, ref: 'faux/media', id: 'media', caps: { ...FAUX_MODEL.caps, input: ['text', 'image'] } };

export const ALIASES: Record<string, string> = {
  opus: 'anthropic/claude-opus-5-5',
  'opus-fast': 'anthropic/claude-opus-5-5-fast',
  fable: 'anthropic/claude-fable-5-1',
  sonnet: 'anthropic/claude-sonnet-5-5',
  haiku: 'opencode-go/claude-haiku-5-5',
  deepseek: 'opencode-go/deepseek-v4.1-flash',
  'deepseek-api': 'deepseek/deepseek-v4.1-flash',
  'deepseek-or': 'openrouter/deepseek-v4.1-flash',
  'haiku-or': 'openrouter/claude-haiku-5-5',
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

// Local (self-hosted) models declared in ~/.cedia/settings.json under `localModels`:
// [{ "ref": "local/llama", "id": "llama3.1", "wire": "chat-completions", "url": "http://localhost:11434/v1/chat/completions", "contextWindow": 128000 }]
export const LOCAL_MODEL_CACHE = 'local-models-cache.json';

export function localModelCachePath(home = cediaHome()): string {
  return join(home, LOCAL_MODEL_CACHE);
}

export function loadLocalModelCache(home = cediaHome()): ModelSpec[] {
  const p = localModelCachePath(home);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw as ModelSpec[];
  } catch {
    return [];
  }
}

async function probe(url: string, timeoutMs = 300): Promise<Response | undefined> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return res;
  } catch {
    return undefined;
  }
}

function mkSpec(ref: string, id: string, url: string, ctx: number, reasoning = false): ModelSpec {
  return {
    ref,
    id,
    wire: 'chat-completions',
    url,
    auth: { env: '', scheme: 'bearer' },
    local: true,
    maxOutput: 8192,
    price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    dataPolicy: 'retained',
    caps: {
      reasoning: reasoning ? 'reasoning_content' : 'none',
      replayReasoning: 'same-turn',
      parallelToolCalls: true,
      input: ['text'],
      effortLevels: [],
      cacheMinTokens: 0,
      cacheBlockTokens: 0,
      midConversationSystem: true,
      midConversationEffort: false,
      contextWindow: ctx,
    },

  } as unknown as ModelSpec;
}

export async function discoverLocalModels(home = cediaHome()): Promise<ModelSpec[]> {
  const out: ModelSpec[] = [];
  const env = process.env;
  // Ollama
  const ollamaBase = (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const tags = await probe(`${ollamaBase}/api/tags`, 400);
  if (tags && tags.ok) {
    try {
      const data = (await tags.json()) as { models?: { name: string }[] };
      for (const m of data.models ?? []) {
        let ctx = 128_000;
        let reasoning = /r1|thinking|reasoner|qwen3/i.test(m.name);
        let tools = true;
        try {
          const showRes = await probe(`${ollamaBase}/api/show`, 400);
          if (showRes && showRes.ok) {
            const show = (await showRes.json()) as { model_info?: Record<string, unknown>; capabilities?: string[] };
            for (const [k, v] of Object.entries(show.model_info ?? {})) {
              if (k.endsWith('.context_length') && typeof v === 'number') { ctx = v; break; }
            }
            if (Array.isArray(show.capabilities)) {
              tools = show.capabilities.includes('tools');
              if (show.capabilities.includes('thinking')) reasoning = true;
            }
          }
        } catch {}
        const spec = mkSpec(`ollama/${m.name}`, m.name, `${ollamaBase}/v1/chat/completions`, ctx, reasoning);
        (spec as { caps: { parallelToolCalls: boolean } }).caps.parallelToolCalls = tools;
        out.push(spec);
      }
    } catch {}
  }
  // LM Studio
  const lmBase = (env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234').replace(/\/$/, '');
  const lm = await probe(`${lmBase}/v1/models`, 400);
  if (lm && lm.ok) {
    try {
      const data = (await lm.json()) as { data?: { id: string }[] };
      for (const m of data.data ?? []) {
        out.push(mkSpec(`lmstudio/${m.id}`, m.id, `${lmBase}/v1/chat/completions`, 128_000));
      }
    } catch {}
  }
  // llama.cpp
  const llamaBase = (env.LLAMA_CPP_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const llama = await probe(`${llamaBase}/v1/models`, 400);
  if (llama && llama.ok) {
    try {
      const data = (await llama.json()) as { data?: { id: string; max_model_len?: number }[] };
      for (const m of data.data ?? []) {
        out.push(mkSpec(`llamacpp/${m.id}`, m.id, `${llamaBase}/v1/chat/completions`, m.max_model_len ?? 128_000, /r1|thinking|reasoner|qwen3/i.test(m.id)));
      }
    } catch {}
  }
  // vLLM
  const vllmBase = (env.VLLM_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
  const vllm = await probe(`${vllmBase}/v1/models`, 400);
  if (vllm && vllm.ok) {
    try {
      const data = (await vllm.json()) as { data?: { id: string; max_model_len?: number }[] };
      for (const m of data.data ?? []) {
        out.push(mkSpec(`vllm/${m.id}`, m.id, `${vllmBase}/v1/chat/completions`, m.max_model_len ?? 128_000));
      }
    } catch {}
  }
  return out;
}

export async function refreshLocalModelCache(home = cediaHome()): Promise<ModelSpec[]> {
  const found = await discoverLocalModels(home);
  try {
    writeFileSync(localModelCachePath(home), JSON.stringify(found, null, 2));
  } catch {}
  return found;
}

export function localModels(): ModelSpec[] {
  const cached = loadLocalModelCache();
  let raw: unknown;
  try {
    raw = (readSettings as (p: string) => { localModels?: unknown[] })(join(cediaHome(), 'settings.json')).localModels;
  } catch {
    raw = undefined;
  }
  if (!Array.isArray(raw)) return [];
  const out: ModelSpec[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const ref = typeof o.ref === 'string' ? o.ref : undefined;
    const id = typeof o.id === 'string' ? o.id : ref;
    const url = typeof o.url === 'string' ? o.url : undefined;
    if (!ref || !url) continue;
    const wire = (o.wire === 'anthropic-messages' || o.wire === 'openai-responses') ? o.wire : 'chat-completions';
    const ctx = typeof o.contextWindow === 'number' ? o.contextWindow : 128_000;
    const reasoning = o.reasoning === true;
    const maxOut = typeof o.maxOutput === 'number' ? o.maxOutput : 8_192;
    out.push({
      ref,
      id: id ?? ref,
      wire,
      url,
      auth: { env: typeof o.authEnv === 'string' ? o.authEnv : '', scheme: 'bearer' },
      local: true,
      maxOutput: maxOut,
      defaultEffort: undefined,
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      dataPolicy: 'retained',
      caps: {
        reasoning: reasoning ? 'reasoning_content' : 'none',
        replayReasoning: 'forbidden',
        parallelToolCalls: true,
        input: ['text'],
        effortLevels: [],
        cacheMinTokens: 0,
        cacheBlockTokens: 0,
        midConversationSystem: true,
        midConversationEffort: false,
        contextWindow: ctx,
      },
    } as unknown as ModelSpec);
  }
  return out;
}

export function resolveModel(ref: string): ModelSpec {
  const full = ALIASES[ref] ?? ref;
  if (full === FAUX_MODEL.ref) return FAUX_MODEL;
  if (full === FAUX_FALLBACK.ref) return FAUX_FALLBACK;
  if (full === FAUX_MEDIA.ref) return FAUX_MEDIA;
  const m = [...CATALOG, ...localModels()].find((c) => c.ref === full);
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
  const hour = usage.cacheWrite1h ?? 0;
  return (usage.uncached * pr.input + usage.cacheRead * pr.cacheRead + (usage.cacheWrite - hour) * pr.cacheWrite + hour * 2 * pr.input + usage.output * pr.output) / 1_000_000;
}
