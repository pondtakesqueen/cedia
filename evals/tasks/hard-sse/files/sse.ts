export type SseMessage = { event?: string; data: string };

// Streaming server-sent events reader for model provider responses.
//
// - Bytes arrive in chunks of any size: a line, a field name or a multi-byte UTF-8 character may be split
//   across chunks. Yield each message as soon as its blank line arrives; never wait for the end of the body.
// - Lines end with \n or \r\n.
// - A line starting with `:` is a comment and is ignored.
// - `field: value` sets a field; one space after the colon is dropped, any further spaces are kept.
//   A line with no colon is a field with an empty value.
// - `event` names the message. Each `data` line adds a line to the message's data; lines are joined with \n.
//   Other fields (id, retry, anything else) are ignored.
// - A blank line ends the message: yield { event, data } if it had at least one data line, then reset both.
//   A message with an event but no data is dropped.
// - When the body ends without a final blank line, data lines still pending (including a last line with no
//   newline) are yielded as one last message.
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  throw new Error('not implemented');
}

export function streamFromString(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}
