import type { EventOf, Message, SessionEvent, UserPart } from '../types.ts';

// Rebuild the conversation from the log. Pure: the same events always give the same messages,
// so a request can be reconstructed byte for byte and the prefix only ever grows.
export function buildMessages(events: SessionEvent[]): Message[] {
  const out: Message[] = [];
  const pushUser = (part: UserPart) => {
    const last = out.at(-1);
    if (last?.role === 'user') {
      // Anthropic wants tool results before any text in a user message.
      if (part.type === 'tool_result' && last.parts.some((p) => p.type === 'text')) out.push({ role: 'user', parts: [part] });
      else last.parts.push(part);
    } else out.push({ role: 'user', parts: [part] });
  };
  for (const e of events) {
    switch (e.kind) {
      case 'user':
        pushUser({ type: 'text', text: e.text });
        break;
      case 'summary':
        // Only Anthropic writes summaries, so the block replays to its wire.
        out.push({ role: 'assistant', wire: 'anthropic-messages', blocks: [e.block] });
        break;
      case 'assistant':
        if (e.blocks.length) out.push({ role: 'assistant', wire: e.wire, blocks: e.blocks });
        break;
      case 'tool_result':
        pushUser({ type: 'tool_result', callId: e.callId, text: e.output.text, isError: e.output.isError });
        break;
      case 'reminder':
        if (e.as === 'system') out.push({ role: 'system', text: e.text });
        else pushUser({ type: 'text', text: e.text });
        break;
      case 'effort':
        out.push({ role: 'effort', effort: e.effort });
        break;
    }
  }
  return out;
}

export function sessionHeader(events: SessionEvent[]): EventOf<'session'> {
  const first = events[0];
  if (first?.kind !== 'session') throw new Error('session log must start with a session event');
  return first;
}
