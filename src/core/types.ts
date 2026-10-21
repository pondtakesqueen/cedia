// Data shapes for the core. SPEC.md "Core shapes" is the source of truth; change both together.

export type JsonObject = { [key: string]: unknown };

export type EventId = string & { readonly brand: 'EventId' };
export type Wire = 'anthropic-messages' | 'chat-completions' | 'openai-responses' | 'faux';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
export type ToolOutput = { text: string; isError: boolean; exitCode?: number; spillPath?: string; images?: string[] };
export type ToolEffect = 'read' | 'write_workspace' | 'exec' | 'network';

export type AttemptErrorCode =
  | 'rate_limit' | 'overloaded' | 'auth' | 'bad_request' | 'network' | 'timeout' | 'server' | 'context_length';
export type AttemptError = { code: AttemptErrorCode; status?: number; retryAfterMs?: number; message: string };

export type ToolDef = { name: string; description: string; schema: JsonObject };

export type TurnEndReason = 'completed' | 'aborted' | 'error' | 'max_tokens' | 'budget' | 'max_turns';

type EventBody =
  | { kind: 'session'; cwd: string; role: string; model: string; system: string; tools: ToolDef[]; parentSession?: string }
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
  | { kind: 'attempt'; requestId: EventId; n: number; error?: AttemptError }
  | { kind: 'assistant'; wire: Wire; model: string; blocks: AssistantBlock[]; stop: StopReason; usage: Usage }
  | { kind: 'snapshot'; tree: string; callId?: string; changed: string[] } // shadow-git tree after a writing call
  | { kind: 'permission'; callId: string; tool: string; decision: 'allow' | 'deny'; rule: string; reason?: string }
  | { kind: 'tool_intent'; callId: string; tool: string; input: JsonObject }
  | { kind: 'tool_result'; callId: string; status: EffectStatus; output: ToolOutput }
  | { kind: 'reminder'; text: string; as: 'system' | 'user' }
  | { kind: 'turn_end'; reason: TurnEndReason; cause?: 'user' | 'parent' | 'hook' };

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
  | { role: 'system'; text: string };

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
};

export type Evidence = { changed: string[]; checks: { command: string; exitCode: number }[]; unverified: string[] };

export type ResultSubtype =
  | 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | 'interrupted' | 'error_unverified_claim';

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
};

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
