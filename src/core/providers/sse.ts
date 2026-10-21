export type SseMessage = { event?: string; data: string };

// Minimal server-sent events reader: handles chunk splits, CRLF, comments and multi-line data.
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  const flush = function* () {
    if (data.length) yield { event, data: data.join('\n') };
    event = undefined;
    data = [];
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') yield* flush();
      else if (line.startsWith(':')) continue;
      else {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
  }
  buf += decoder.decode();
  if (buf.trim()) data.push(...buf.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()));
  yield* flush();
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
