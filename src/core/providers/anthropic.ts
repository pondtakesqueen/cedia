import type { AssistantBlock, JsonObject, Message, Provider, StopReason, StreamEvent, Usage, WireRequest } from '../types.ts';
import { Assembler } from './assemble.ts';
import { authHeaders, classifyStreamError, post, type Fetcher } from './http.ts';
import { readSse } from './sse.ts';

const WIRE = 'anthropic-messages';

function assistantContent(blocks: AssistantBlock[], sameWire: boolean): JsonObject[] {
  return blocks.flatMap((b): JsonObject[] => {
    if (b.type === 'text') return b.text ? [{ type: 'text', text: b.text }] : [];
    if (b.type === 'thinking') {
      // Thinking is bound to the model and prefix that produced it; only replay our own, unedited.
      if (!sameWire || !b.opaque) return [];
      return b.redacted ? [{ type: 'redacted_thinking', data: b.opaque }] : [{ type: 'thinking', thinking: b.text, signature: b.opaque }];
    }
    return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }];
  });
}

export function anthropicMessages(messages: Message[], midConversationSystem: boolean): JsonObject[] {
  const out: { role: 'user' | 'assistant'; content: JsonObject[] }[] = [];
  const push = (role: 'user' | 'assistant', content: JsonObject[]) => {
    if (!content.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const m of messages) {
    if (m.role === 'assistant') push('assistant', assistantContent(m.blocks, m.wire === WIRE));
    else if (m.role === 'system') push('user', [{ type: 'text', text: midConversationSystem ? m.text : `<system-reminder>\n${m.text}\n</system-reminder>` }]);
    else
      push(
        'user',
        m.parts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'tool_result', tool_use_id: p.callId, content: p.text, ...(p.isError ? { is_error: true } : {}) },
        ),
      );
  }
  return out;
}

export function anthropicBody(req: WireRequest): JsonObject {
  const ttl = req.ttl === '1h' ? { ttl: '1h' } : {};
  const tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  return {
    model: req.model.id,
    max_tokens: req.maxTokens,
    stream: true,
    // Explicit breakpoint at the end of the static prefix, automatic caching for the growing tail.
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral', ...ttl } }],
    ...(tools.length ? { tools } : {}),
    messages: anthropicMessages(req.messages, req.model.caps.midConversationSystem),
    cache_control: { type: 'ephemeral', ...ttl },
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
  };
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  pause_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'refusal',
};

// Parses an Anthropic Messages SSE stream into StreamEvents.
export async function* parseAnthropic(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const a = new Assembler();
  const usage: Usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let stop: StopReason = 'end_turn';
  let started = false;
  let finished = false;
  const applyUsage = (u: Record<string, number | undefined> | undefined) => {
    if (!u) return;
    if (u.input_tokens !== undefined) usage.uncached = u.input_tokens;
    if (u.cache_read_input_tokens !== undefined) usage.cacheRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens !== undefined) usage.cacheWrite = u.cache_creation_input_tokens;
    if (u.output_tokens !== undefined) usage.output = u.output_tokens;
  };
  for await (const msg of readSse(body)) {
    let d: any;
    try {
      d = JSON.parse(msg.data);
    } catch {
      continue;
    }
    const key = String(d.index);
    switch (d.type) {
      case 'message_start':
        started = true;
        yield { type: 'start' };
        applyUsage(d.message?.usage);
        break;
      case 'content_block_start': {
        const cb = d.content_block ?? {};
        if (cb.type === 'text') a.text(key, cb.text ?? '');
        else if (cb.type === 'thinking') {
          a.thinking(key, cb.thinking ?? '');
          if (cb.signature) a.opaque(key, cb.signature, false);
        } else if (cb.type === 'redacted_thinking') {
          a.thinking(key, '', { redacted: true });
          a.opaque(key, cb.data ?? '', false);
        } else if (cb.type === 'tool_use') a.toolStart(key, cb.id, cb.name);
        break;
      }
      case 'content_block_delta': {
        const dl = d.delta ?? {};
        if (dl.type === 'text_delta') a.text(key, dl.text);
        else if (dl.type === 'thinking_delta') a.thinking(key, dl.thinking);
        else if (dl.type === 'signature_delta') a.opaque(key, dl.signature);
        else if (dl.type === 'input_json_delta') a.toolArgs(key, dl.partial_json);
        break;
      }
      case 'content_block_stop':
        a.end(key);
        break;
      case 'message_delta':
        if (d.delta?.stop_reason) stop = STOP[d.delta.stop_reason] ?? 'end_turn';
        applyUsage(d.usage);
        break;
      case 'message_stop':
        finished = true;
        break;
      case 'error':
        yield* a.drain();
        yield { type: 'error', error: classifyStreamError(d.error?.type, d.error?.message ?? 'stream error') };
        return;
    }
    yield* a.drain();
  }
  if (!started || !finished) {
    yield { type: 'error', error: { code: 'network', message: 'stream ended before message_stop' } };
    return;
  }
  a.endAll();
  yield* a.drain();
  yield { type: 'done', blocks: a.finish(stop === 'max_tokens'), stop, usage };
}

export function anthropicProvider(fetcher?: Fetcher): Provider {
  const p: Provider = {
    wire: WIRE,
    body: anthropicBody,
    headers: (req) => ({
      'anthropic-version': '2023-06-01',
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
      yield* parseAnthropic(res.body);
    },
  };
  return p;
}
