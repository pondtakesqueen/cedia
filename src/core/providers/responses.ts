import type { JsonObject, Provider, StopReason, StreamEvent, Usage, WireRequest } from '../types.ts';
import { Assembler } from './assemble.ts';
import { authHeaders, classifyStreamError, post, type Fetcher } from './http.ts';
import { readSse } from './sse.ts';

const WIRE = 'openai-responses';

export function responsesInput(req: WireRequest): JsonObject[] {
  const out: JsonObject[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') out.push({ role: 'developer', content: m.text });
    else if (m.role === 'user') {
      for (const p of m.parts) {
        if (p.type === 'tool_result') out.push({ type: 'function_call_output', call_id: p.callId, output: p.text });
        else out.push({ role: 'user', content: [{ type: 'input_text', text: p.text }] });
      }
    } else {
      for (const b of m.blocks) {
        if (b.type === 'thinking') {
          // The whole reasoning item (with encrypted_content) is kept opaque and sent back unchanged.
          if (m.wire === WIRE && b.opaque) out.push(JSON.parse(b.opaque) as JsonObject);
        } else if (b.type === 'text') {
          if (b.text) out.push({ role: 'assistant', content: b.text });
        } else if (b.type === 'tool_use') out.push({ type: 'function_call', call_id: b.callId ?? b.id, name: b.name, arguments: JSON.stringify(b.input) });
      }
    }
  }
  return out;
}

export function responsesBody(req: WireRequest): JsonObject {
  const tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema }));
  const reasoning = req.model.caps.reasoning === 'responses-item';
  return {
    model: req.model.id,
    stream: true,
    store: false,
    instructions: req.system,
    input: responsesInput(req),
    ...(tools.length ? { tools } : {}),
    max_output_tokens: req.maxTokens,
    ...(reasoning ? { reasoning: { ...(req.effort ? { effort: req.effort } : {}), summary: 'auto' }, include: ['reasoning.encrypted_content'] } : {}),
    ...(req.model.cacheKeyField ? { [req.model.cacheKeyField]: req.sessionId } : {}),
  };
}

function responsesUsage(u: any): Usage {
  const input = u?.input_tokens ?? 0;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  const reasoning = u?.output_tokens_details?.reasoning_tokens;
  return { uncached: Math.max(0, input - cached), cacheRead: cached, cacheWrite: 0, output: u?.output_tokens ?? 0, ...(reasoning ? { reasoning } : {}) };
}

export async function* parseResponses(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const a = new Assembler();
  let started = false;
  for await (const msg of readSse(body)) {
    let d: any;
    try {
      d = JSON.parse(msg.data);
    } catch {
      continue;
    }
    const key = String(d.output_index);
    switch (d.type) {
      case 'response.created':
        if (!started) yield { type: 'start' };
        started = true;
        break;
      case 'response.output_item.added': {
        const it = d.item ?? {};
        if (it.type === 'reasoning') a.thinking(key, '');
        else if (it.type === 'message') a.text(key, '');
        else if (it.type === 'function_call') a.toolStart(key, it.id ?? it.call_id, it.name ?? '', it.call_id);
        break;
      }
      case 'response.output_text.delta':
        a.text(key, d.delta ?? '');
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        a.thinking(key, d.delta ?? '');
        break;
      case 'response.function_call_arguments.delta':
        a.toolArgs(key, d.delta ?? '');
        break;
      case 'response.output_item.done': {
        const it = d.item ?? {};
        if (it.type === 'reasoning') a.opaque(key, JSON.stringify(it), false);
        else if (it.type === 'function_call') {
          a.toolPatch(key, { id: it.id, callId: it.call_id, name: it.name });
          if (typeof it.arguments === 'string') a.toolArgs(key, it.arguments, true);
        }
        a.end(key);
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const r = d.response ?? {};
        a.endAll();
        yield* a.drain();
        const reason = r.incomplete_details?.reason;
        const blocks = a.finish(reason === 'max_output_tokens');
        let stop: StopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
        if (reason === 'max_output_tokens') stop = 'max_tokens';
        else if (reason === 'content_filter') stop = 'refusal';
        yield { type: 'done', blocks, stop, usage: responsesUsage(r.usage) };
        return;
      }
      case 'response.failed':
        yield* a.drain();
        yield { type: 'error', error: classifyStreamError(d.response?.error?.code, d.response?.error?.message ?? 'response failed') };
        return;
      case 'error':
        yield* a.drain();
        yield { type: 'error', error: classifyStreamError(d.code ?? d.error?.type, d.message ?? d.error?.message ?? 'stream error') };
        return;
    }
    yield* a.drain();
  }
  yield { type: 'error', error: { code: 'network', message: 'stream ended before response.completed' } };
}

export function responsesProvider(fetcher?: Fetcher): Provider {
  const p: Provider = {
    wire: WIRE,
    body: responsesBody,
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
      yield* parseResponses(res.body);
    },
  };
  return p;
}
