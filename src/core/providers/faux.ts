import { stableJson } from '../hash.ts';
import type { AssistantBlock, AttemptError, JsonObject, Provider, Refusal, StopReason, StreamEvent, Usage, WireRequest } from '../types.ts';

// Offline provider for tests. A script is a list of steps; each step is a reply or a function of the request.
// A reply with `when` is kept for the first request whose first message contains that text, so sessions that run at once
// (parallel sub-threads) each get their own steps whatever order their requests come in.
// Usage is computed from the prefix actually sent, so cacheRead is nonzero exactly when the prefix repeats.
// Shape modeled on pi's faux provider (MIT); no code copied.

export type FauxReply = ({ blocks: AssistantBlock[]; stop?: StopReason; refusal?: Refusal; served?: string } | { error: AttemptError } | { hang: true }) & { when?: string };
export type FauxStep = FauxReply | ((req: WireRequest, state: FauxState) => FauxReply);
export type FauxState = { callCount: number; prompts: string[]; bodies: JsonObject[] };

export function fauxProvider(script: FauxStep[] | ((req: WireRequest, state: FauxState) => FauxReply), opts: { chunk?: number } = {}) {
  const state: FauxState = { callCount: 0, prompts: [], bodies: [] };
  const steps = Array.isArray(script) ? [...script] : null;
  const chunk = opts.chunk ?? 8;
  const p: Provider & { state: FauxState; append(...s: FauxStep[]): void } = {
    wire: 'faux',
    state,
    append: (...s) => steps?.push(...s),
    body: (req: WireRequest): JsonObject => ({ model: req.model.id, system: req.system, tools: req.tools, messages: req.messages }),
    headers: (req) => ({ ...(req.model.sessionHeader ? { [req.model.sessionHeader]: req.sessionId } : {}) }),
    async *stream(req, signal): AsyncGenerator<StreamEvent> {
      // Matched against the session's first message, which holds its task: later ones (a spawn call naming a
      // child's task) would let one session take another's steps.
      const sent = JSON.stringify(req.messages[0] ?? '');
      const at = steps ? steps.findIndex((s) => typeof s === 'function' || s.when === undefined || sent.includes(s.when)) : -1;
      const step: FauxStep | undefined = steps ? (at >= 0 ? steps.splice(at, 1)[0] : undefined) : (script as FauxStep);
      state.callCount++;
      if (!step) {
        yield { type: 'error', error: { code: 'bad_request', message: `faux script exhausted at call ${state.callCount}` } };
        return;
      }
      const reply = typeof step === 'function' ? step(req, state) : step;
      // Rendered in wire order (system, tools, then messages) so the shared prefix is what a real cache would see.
      const prompt = stableJson(req.system) + stableJson(req.tools) + stableJson(req.messages);
      state.bodies.push(p.body(req));
      const usage = fauxUsage(prompt, state.prompts);
      state.prompts.push(prompt);
      if ('error' in reply) {
        yield { type: 'error', error: reply.error };
        return;
      }
      yield { type: 'start' };
      if ('hang' in reply) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'done', blocks: [], stop: 'aborted', usage };
        return;
      }
      let out = 0;
      for (const [index, b] of reply.blocks.entries()) {
        if (signal.aborted) {
          yield { type: 'done', blocks: reply.blocks.slice(0, index), stop: 'aborted', usage };
          return;
        }
        // A compaction block arrives whole, as on the Anthropic wire.
        if (b.type === 'compaction' || b.type === 'fallback') continue;
        const text = b.type === 'tool_use' ? JSON.stringify(b.input) : b.text;
        out += Math.ceil(text.length / 4);
        if (b.type === 'tool_use') yield { type: 'toolcall_start', index, id: b.id, name: b.name };
        else yield { type: b.type === 'text' ? 'text_start' : 'thinking_start', index };
        for (let i = 0; i < text.length; i += chunk) {
          const delta = text.slice(i, i + chunk);
          yield b.type === 'tool_use'
            ? { type: 'toolcall_delta', index, delta }
            : { type: b.type === 'text' ? 'text_delta' : 'thinking_delta', index, delta };
          await Promise.resolve();
        }
        yield { type: b.type === 'tool_use' ? 'toolcall_end' : b.type === 'text' ? 'text_end' : 'thinking_end', index };
      }
      const stop = reply.stop ?? (reply.blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
      yield { type: 'done', blocks: reply.blocks, stop, usage: { ...usage, output: out }, ...(reply.refusal ? { refusal: reply.refusal } : {}), ...(reply.served ? { served: reply.served } : {}) };
    },
  };
  return p;
}

// Tokens are approximated as chars/4; the cached part is the longest prefix shared with any earlier prompt.
export function fauxUsage(prompt: string, previous: string[]): Usage {
  let best = 0;
  for (const prev of previous) {
    const n = Math.min(prev.length, prompt.length);
    let i = 0;
    while (i < n && prev.charCodeAt(i) === prompt.charCodeAt(i)) i++;
    if (i > best) best = i;
  }
  const total = Math.ceil(prompt.length / 4);
  const cacheRead = Math.floor(best / 4);
  return { uncached: total - cacheRead, cacheRead, cacheWrite: 0, output: 0 };
}

export const text = (t: string): AssistantBlock => ({ type: 'text', text: t });
export const toolUse = (id: string, name: string, input: JsonObject): AssistantBlock => ({ type: 'tool_use', id, name, input });
