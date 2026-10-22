// Data shapes for the core. SPEC.md "Core shapes" is the source of truth; change both together.

export type JsonObject = { [key: string]: unknown };

export type EventId = string & { readonly brand: 'EventId' };
export type Wire = 'anthropic-messages' | 'chat-completions' | 'openai-responses' | 'faux';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
// Lowest first.
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Disjoint counts: total input = uncached + cacheRead + cacheWrite.
export type Usage = { uncached: number; cacheRead: number; cacheWrite: number; output: number; reasoning?: number };
export const ZERO_USAGE: Usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'aborted' | 'error';

// Opaque fields carry each wire's reasoning payload so it replays byte for byte to the same wire.
export type AssistantBlock =
  | { type: 'text'; text: string; sig?: string }
  | { type: 'thinking'; text: string; opaque?: string; redacted?: boolean }
  | { type: 'tool_use'; id: string; callId?: string; name: string; input: JsonObject; inputError?: string };

export type EffectStatus = 'completed' | 'failed' | 'denied' | 'not_started' | 'interrupted_safe' | 'interrupted_unknown';
// `redacted` counts secrets cedia replaced before the output was logged and sent.
export type ToolOutput = { text: string; isError: boolean; exitCode?: number; spillPath?: string; images?: string[]; redacted?: number };
// no-training: models that train on prompts run only in repos marked public. zdr: only zero-data-retention models.
export type PrivacyLevel = 'no-training' | 'zdr';
export type ToolEffect = 'read' | 'write_workspace' | 'exec' | 'network';

export type AttemptErrorCode =
  | 'rate_limit' | 'overloaded' | 'auth' | 'bad_request' | 'network' | 'timeout' | 'server' | 'context_length'
  | 'quota'; // the plan's usage limit or the account balance ran out: waiting seconds will not help
export type AttemptError = { code: AttemptErrorCode; status?: number; retryAfterMs?: number; message: string };

export type ToolDef = { name: string; description: string; schema: JsonObject };

export type TurnEndReason = 'completed' | 'aborted' | 'error' | 'max_tokens' | 'budget' | 'max_turns' | 'handoff';

type EventBody =
  | { kind: 'session'; cwd: string; role: string; model: string; system: string; tools: ToolDef[]; parentSession?: string; thread?: string }
  | { kind: 'user'; text: string }
  | {
      kind: 'request';
      model: string;
      effort?: Effort;
      toolsHash: string;
      systemHash: string;
      bodyHash: string;
      ttl?: '5m' | '1h';
      headers: Record<string, string>; // header name -> hash of the value, never the value
    }
  // ttftMs: until the provider starts streaming; ms: the whole attempt.
  | { kind: 'attempt'; requestId: EventId; n: number; error?: AttemptError; ttftMs?: number; ms?: number }
  | { kind: 'assistant'; wire: Wire; model: string; blocks: AssistantBlock[]; stop: StopReason; usage: Usage }
  // The request's body sent again with no output while a tool runs long, so its cached prefix does not expire
  // (core/loop/run.ts). Nothing reaches the model's context; it is logged for its cost.
  | { kind: 'keepalive'; requestId: EventId; usage?: Usage; error?: AttemptError; ms: number }
  | { kind: 'snapshot'; tree: string; callId?: string; changed: string[]; ms?: number } // shadow-git tree after a writing call
  | { kind: 'permission'; callId: string; tool: string; decision: 'allow' | 'deny'; rule: string; reason?: string }
  | { kind: 'tool_intent'; callId: string; tool: string; input: JsonObject }
  | { kind: 'tool_result'; callId: string; status: EffectStatus; output: ToolOutput }
  | { kind: 'reminder'; text: string; as: 'system' | 'user' }
  // A user hook ran (core/hooks.ts): which, at what point, for which call, and what it decided. What it said that
  // reaches the model is in the permission, tool_result or reminder that follows.
  | { kind: 'hook'; hook: string; event: 'preToolUse' | 'postToolUse' | 'stop'; callId?: string; decision: 'allow' | 'block'; failed?: boolean; updated?: boolean; ms: number }
  // A per-message effort change: from the latest user turn with new input on, the model works at this level
  // (core/loop/run.ts escalation). Wires without it (caps.midConversationEffort) never get one.
  | { kind: 'effort'; effort: Effort }
  | { kind: 'turn_end'; reason: TurnEndReason; cause?: 'user' | 'parent' | 'hook' }
  // The run's result (its receipt and evidence), written to the run's last writer session after its last turn_end,
  // so a client that rebuilds a thread from the files can show it. It never reaches a model.
  | { kind: 'result'; result: HeadlessResult };

export type SessionEvent = { id: EventId; parentId: EventId | null; at: string } & EventBody;
export type EventOf<K extends SessionEvent['kind']> = Extract<SessionEvent, { kind: K }>;
export type NewEvent = EventBody;

// Wire-neutral conversation the context builder produces and each adapter translates.
export type UserPart =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; callId: string; text: string; isError: boolean };
export type Message =
  | { role: 'user'; parts: UserPart[] }
  | { role: 'assistant'; wire: Wire; blocks: AssistantBlock[] }
  | { role: 'system'; text: string }
  | { role: 'effort'; effort: Effort };

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }; // USD per 1M tokens

export type ModelCapabilities = {
  reasoning: 'anthropic-thinking' | 'reasoning_content' | 'responses-item' | 'none';
  replayReasoning: 'required' | 'forbidden' | 'same-turn';
  parallelToolCalls: boolean;
  input: ('text' | 'image')[];
  effortLevels: Effort[];
  cacheMinTokens: number;
  cacheBlockTokens: number; // providers cache whole blocks; a read up to one block short of the previous input is a full hit
  midConversationSystem: boolean;
  // Effort can change by a message mid-conversation, keeping the cached prefix (Anthropic's per-message effort).
  midConversationEffort: boolean;
  contextWindow: number;
};

export type ModelSpec = {
  ref: string; // 'anthropic/claude-opus-5-5'
  id: string; // id sent on the wire
  wire: Wire;
  url: string;
  auth: { env: string; altEnv?: string; scheme: 'x-api-key' | 'bearer' }; // altEnv: read when env is empty
  headers?: Record<string, string>;
  sessionHeader?: string; // e.g. x-opencode-session
  cacheKeyField?: 'prompt_cache_key';
  maxOutput: number;
  defaultEffort?: Effort;
  price: Price & { offPeak?: Price & { isOffPeak: (d: Date) => boolean }; above?: { tokens: number; price: Price } };
  dataPolicy: 'zdr' | 'retained' | 'trains';
  // Anthropic fast mode: the same model decoding up to 2.5x faster at a premium price. Its own catalog entry,
  // because a speed change invalidates the prompt cache and changes the price.
  speed?: 'fast';
  caps: ModelCapabilities;
};

export type WireRequest = {
  model: ModelSpec;
  sessionId: string;
  system: string;
  tools: ToolDef[];
  messages: Message[];
  effort?: Effort;
  maxTokens: number;
  ttl?: '5m' | '1h';
};

export type StreamEvent =
  | { type: 'start' }
  | { type: 'text_start'; index: number }
  | { type: 'text_delta'; index: number; delta: string }
  | { type: 'text_end'; index: number }
  | { type: 'thinking_start'; index: number }
  | { type: 'thinking_delta'; index: number; delta: string }
  | { type: 'thinking_end'; index: number }
  | { type: 'toolcall_start'; index: number; id: string; name: string }
  | { type: 'toolcall_delta'; index: number; delta: string }
  | { type: 'toolcall_end'; index: number }
  | { type: 'done'; blocks: AssistantBlock[]; stop: StopReason; usage: Usage }
  | { type: 'error'; error: AttemptError };

export type Provider = {
  wire: Wire;
  // Pure translation, so a request event can hash the exact body before it is sent.
  body(req: WireRequest): JsonObject;
  headers(req: WireRequest): Record<string, string>;
  stream(req: WireRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  // Reads the request's prefix into the cache again without generating anything, which restarts its lifetime.
  // Only for a provider whose cache expires within minutes (Anthropic's 5-minute default).
  keepAlive?(req: WireRequest, signal: AbortSignal): Promise<{ ok: true; usage: Usage } | { ok: false; error: AttemptError }>;
};

// flags: what the slop guard found in this run's changes (see core/trust/slop.ts). A check's thread is the thread
// whose session ran it: a run's result pools its sub-threads' checks with its own.
export type Check = { command: string; exitCode: number; thread?: string };
export type Evidence = { changed: string[]; checks: Check[]; unverified: string[]; flags?: string[] };

// 'handoff' ends a session, never a run: the session wrote its handoff note (the result) and the client goes on
// in a new session of the same thread.
export type ResultSubtype =
  | 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | 'interrupted' | 'error_unverified_claim'
  | 'handoff';

export type HeadlessResult = {
  type: 'result';
  subtype: ResultSubtype;
  sessionId: string;
  numTurns: number;
  usage: Usage;
  costUsd: number;
  cacheHitRatio: number;
  result: string;
  evidence?: Evidence;
  timing?: Timing;
  // Tokens in the largest context one reply saw (the request plus the reply); across the run's own sessions, the
  // largest. A sub-thread's sessions count in spawned.peakContext instead.
  peakContext?: number;
  // The plan the writer was given, and the review of its change (see core/trust/review.ts).
  plan?: Step;
  review?: Step & { verdict: 'approve' | 'changes' | 'unclear'; fixed: boolean };
  // The thread the run belongs to, and every session it took when it handed off or fell back.
  thread?: string;
  sessions?: string[];
  // Sub-threads the run spawned (core/tools/spawn.ts); their spend is in costUsd.
  subthreads?: number;
  spawned?: Spawned;
};

// Sub-threads by kind, the handoffs their sessions made, and the largest context one of their replies saw.
export type Spawned = { explore: number; work: number; handoffs: number; peakContext: number };

// A role run around the writer. `via: 'claude-code'` is the user's own Claude Code CLI (their subscription): its
// session lives in Claude Code, and its reported cost is not added to costUsd.
export type Step = { model: string; via: 'cedia' | 'claude-code'; sessionId: string; costUsd?: number };

// Where a run's wall time went. outputTokPerSec is the model's decode rate: output tokens (thinking included)
// over streaming time. harnessMs is everything that was neither the model nor a tool: cedia's own overhead.
// retryMs is time spent waiting to retry a failed provider call.
export type Timing = { wallMs: number; modelMs: number; ttftMs: number; toolMs: number; retryMs: number; harnessMs: number; outputTokPerSec: number };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    uncached: a.uncached + b.uncached,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) || undefined,
  };
}

export function hitRatio(u: Usage): number {
  const total = u.uncached + u.cacheRead + u.cacheWrite;
  return total === 0 ? 0 : u.cacheRead / total;
}
