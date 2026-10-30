import type { AssistantBlock, FallbackBlock, JsonObject, StreamEvent } from '../types.ts';

type Open =
  | { type: 'text'; text: string; sig?: string }
  | { type: 'thinking'; text: string; opaque?: string; redacted?: boolean; ms?: number; from?: number }
  | { type: 'tool_use'; id: string; callId?: string; name: string; args: string }
  | FallbackBlock;

// Collects wire deltas into AssistantBlocks and the matching StreamEvents.
// Wires key their blocks differently (index, output_index, tool index); `key` is whatever the wire uses.
export class Assembler {
  private blocks: Open[] = [];
  private byKey = new Map<string, number>();
  private closed = new Set<number>();
  readonly events: StreamEvent[] = [];

  private open(key: string, block: Open, ev: StreamEvent): number {
    const index = this.blocks.length;
    this.blocks.push(block);
    this.byKey.set(key, index);
    this.events.push(ev);
    return index;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  text(key: string, delta: string) {
    let i = this.byKey.get(key);
    if (i === undefined) i = this.open(key, { type: 'text', text: '' }, { type: 'text_start', index: this.blocks.length });
    const b = this.blocks[i]!;
    if (b.type !== 'text' || !delta) return;
    b.text += delta;
    this.events.push({ type: 'text_delta', index: i, delta });
  }

  thinking(key: string, delta: string, opts: { redacted?: boolean } = {}) {
    let i = this.byKey.get(key);
    if (i === undefined)
      i = this.open(key, { type: 'thinking', text: '', from: performance.now(), ...(opts.redacted ? { redacted: true } : {}) }, { type: 'thinking_start', index: this.blocks.length });
    const b = this.blocks[i]!;
    if (b.type !== 'thinking' || !delta) return;
    b.text += delta;
    this.events.push({ type: 'thinking_delta', index: i, delta });
  }

  opaque(key: string, value: string, append = true) {
    const i = this.byKey.get(key);
    if (i === undefined) return;
    const b = this.blocks[i]!;
    if (b.type === 'thinking') b.opaque = append ? (b.opaque ?? '') + value : value;
    else if (b.type === 'text') b.sig = append ? (b.sig ?? '') + value : value;
  }

  // A block that arrives whole and streams nothing: it only keeps its place among the others.
  whole(key: string, block: FallbackBlock) {
    if (this.byKey.has(key)) return;
    this.byKey.set(key, this.blocks.length);
    this.closed.add(this.blocks.length);
    this.blocks.push(block);
  }

  toolStart(key: string, id: string, name: string, callId?: string) {
    if (this.byKey.has(key)) return;
    this.open(key, { type: 'tool_use', id, name, args: '', ...(callId ? { callId } : {}) }, { type: 'toolcall_start', index: this.blocks.length, id: callId ?? id, name });
  }

  toolArgs(key: string, delta: string, replace = false) {
    const i = this.byKey.get(key);
    if (i === undefined) return;
    const b = this.blocks[i]!;
    if (b.type !== 'tool_use') return;
    if (replace) {
      b.args = delta;
      return;
    }
    if (!delta) return;
    b.args += delta;
    this.events.push({ type: 'toolcall_delta', index: i, delta });
  }

  toolPatch(key: string, patch: { id?: string; name?: string; callId?: string }) {
    const i = this.byKey.get(key);
    if (i === undefined) return;
    const b = this.blocks[i]!;
    if (b.type !== 'tool_use') return;
    if (patch.id) b.id = patch.id;
    if (patch.name) b.name = patch.name;
    if (patch.callId) b.callId = patch.callId;
  }

  end(key: string) {
    const i = this.byKey.get(key);
    if (i === undefined || this.closed.has(i)) return;
    this.closed.add(i);
    const b = this.blocks[i]!;
    if (b.type === 'thinking') b.ms = thought(b);
    const t = b.type;
    this.events.push({ type: t === 'text' ? 'text_end' : t === 'thinking' ? 'thinking_end' : 'toolcall_end', index: i });
  }

  endAll() {
    for (const key of this.byKey.keys()) this.end(key);
  }

  drain(): StreamEvent[] {
    return this.events.splice(0);
  }

  // `truncated` marks the last tool call as cut off (max_tokens mid call).
  finish(truncated = false): AssistantBlock[] {
    return this.blocks.flatMap((b, i): AssistantBlock[] => {
      if (b.type === 'text') return b.text || b.sig ? [b] : [];
      if (b.type === 'fallback') return [b];
      if (b.type === 'thinking') {
        const { from: _, ...block } = b;
        return [{ ...block, ms: b.ms ?? thought(b) }];
      }
      const isLast = i === this.blocks.length - 1;
      const { input, error } = parseArgs(b.args);
      const inputError = truncated && isLast ? 'tool call was cut off by the output limit' : error;
      return [{ type: 'tool_use', id: b.id, ...(b.callId ? { callId: b.callId } : {}), name: b.name, input, ...(inputError ? { inputError } : {}) }];
    });
  }
}

// Whole milliseconds since a thinking block opened.
const thought = (b: { from?: number }) => (b.from === undefined ? 0 : Math.round(performance.now() - b.from));

export function parseArgs(args: string): { input: JsonObject; error?: string } {
  if (!args.trim()) return { input: {} };
  try {
    const v = JSON.parse(args);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { input: v as JsonObject };
    return { input: {}, error: 'tool input must be a JSON object' };
  } catch (e) {
    return { input: {}, error: `invalid JSON in tool input: ${(e as Error).message}` };
  }
}
