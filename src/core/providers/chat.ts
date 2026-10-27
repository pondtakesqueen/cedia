import { imageNote, withImageNotes } from '../images.ts';
import type { AssistantBlock, JsonObject, Message, Provider, StopReason, StreamEvent, Usage, WireRequest } from '../types.ts';
import { Assembler } from './assemble.ts';
import { authHeaders, classifyStreamError, post, type Fetcher } from './http.ts';
import { readSse } from './sse.ts';

const WIRE = 'chat-completions';

function assistantMessage(blocks: AssistantBlock[], withReasoning: boolean): JsonObject {
  const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const reasoning = blocks.flatMap((b) => (b.type === 'thinking' ? [b.text] : [])).join('');
  const calls = blocks.flatMap((b) =>
    b.type === 'tool_use' ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }] : [],
  );
  return {
    role: 'assistant',
    content: text || null,
    // DeepSeek in thinking mode rejects a tool-call turn replayed without the field, even when the model
    // produced no reasoning that turn, so it goes back as an empty string rather than being left out.
    ...(withReasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

export function chatMessages(req: WireRequest): JsonObject[] {
  const { replayReasoning, midConversationSystem } = req.model.caps;
  // 'same-turn': reasoning goes back only for assistant messages after the last user text (DeepSeek tool loops).
  let lastUserText = -1;
  req.messages.forEach((m, i) => {
    if (m.role === 'user' && m.parts.some((p) => p.type === 'text')) lastUserText = i;
  });
  const out: JsonObject[] = [{ role: 'system', content: req.system }];
  req.messages.forEach((m: Message, i) => {
    // Chat Completions has no per-message effort; the loop never sends one here.
    if (m.role === 'effort') return;
    if (m.role === 'system') out.push(midConversationSystem ? { role: 'system', content: m.text } : { role: 'user', content: `<system-reminder>\n${m.text}\n</system-reminder>` });
    else if (m.role === 'assistant') {
      const withReasoning =
        m.wire === WIRE && req.model.caps.reasoning === 'reasoning_content' && (replayReasoning === 'required' || (replayReasoning === 'same-turn' && i > lastUserText));
      out.push(assistantMessage(m.blocks, withReasoning));
    } else {
      const texts: string[] = [];
      for (const p of m.parts) {
        if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.callId, content: withImageNotes(p.text, p.images) });
        else texts.push(p.type === 'image' ? imageNote(p.image) : p.text);
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
    }
  });
  return out;
}

export function chatBody(req: WireRequest): JsonObject {
  const tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  return {
    model: req.model.id,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens,
    messages: chatMessages(req),
    ...(tools.length ? { tools } : {}),
    ...(req.effort && req.model.caps.effortLevels.length ? { reasoning_effort: req.effort } : {}),
    ...(req.model.body ?? {}),
  };
}

const STOP: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

export async function* parseChat(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const a = new Assembler();
  let usage: Usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let stop: StopReason | undefined;
  let started = false;
  let sawDone = false;
  for await (const msg of readSse(body)) {
    if (msg.data === '[DONE]') {
      sawDone = true;
      break;
    }
    let d: any;
    try {
      d = JSON.parse(msg.data);
    } catch {
      continue;
    }
    if (d.error) {
      yield* a.drain();
      yield { type: 'error', error: classifyStreamError(d.error.type ?? d.error.code, d.error.message ?? 'stream error') };
      return;
    }
    if (!started) {
      started = true;
      yield { type: 'start' };
    }
    const choice = d.choices?.[0];
    const delta = choice?.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
    if (typeof reasoning === 'string' && reasoning) a.thinking('reasoning', reasoning);
    if (typeof delta.content === 'string' && delta.content) {
      a.end('reasoning');
      a.text('text', delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const key = `tool:${tc.index ?? 0}`;
      a.end('reasoning');
      a.end('text');
      if (!a.has(key)) a.toolStart(key, tc.id ?? `call_${tc.index ?? 0}`, tc.function?.name ?? '');
      else a.toolPatch(key, { id: tc.id, name: tc.function?.name });
      if (tc.function?.arguments) a.toolArgs(key, tc.function.arguments);
    }
    if (choice?.finish_reason) stop = STOP[choice.finish_reason] ?? 'end_turn';
    if (d.usage) usage = chatUsage(d.usage);
    yield* a.drain();
  }
  if (!stop) {
    yield { type: 'error', error: { code: 'network', message: sawDone ? 'stream ended without finish_reason' : 'stream ended early' } };
    return;
  }
  a.endAll();
  yield* a.drain();
  yield { type: 'done', blocks: a.finish(stop === 'max_tokens'), stop, usage };
}

// OpenAI reports cached_tokens inside prompt_tokens; DeepSeek reports prompt_cache_hit_tokens. Both are subtracted.
export function chatUsage(u: any): Usage {
  const prompt = u.prompt_tokens ?? 0;
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  return { uncached: Math.max(0, prompt - cached), cacheRead: cached, cacheWrite: 0, output: u.completion_tokens ?? 0, ...(reasoning ? { reasoning } : {}) };
}

export function chatProvider(fetcher?: Fetcher): Provider {
  const p: Provider = {
    wire: WIRE,
    body: chatBody,
    headers: (req) => ({
      ...(req.model.headers ?? {}),
      ...(req.model.sessionHeader ? { [req.model.sessionHeader]: req.sessionId } : {}),
      ...authHeaders(req.model),
    }),
    async *stream(req, signal) {
      const res = await post(req.model.url, p.headers(req), p.body(req), signal, fetcher);
      if (!res.ok) {
        yield { type: 'error', error: res.error };
        return;
      }
      yield* parseChat(res.body);
    },
  };
  return p;
}
