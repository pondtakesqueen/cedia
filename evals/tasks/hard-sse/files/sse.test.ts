import { expect, test } from 'bun:test';
import { readSse, streamFromString, type SseMessage } from './sse.ts';

async function all(text: string, chunk = 7): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of readSse(streamFromString(text, chunk))) out.push(m);
  return out;
}

test('events and data, at every chunk size', async () => {
  const text = 'event: message_start\ndata: {"a":1}\n\nevent: delta\ndata: {"b":2}\n\n';
  for (const chunk of [1, 2, 3, 5, 64])
    expect(await all(text, chunk)).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: 'delta', data: '{"b":2}' },
    ]);
});

test('CRLF line endings, split between chunks too', async () => {
  for (const chunk of [1, 4, 100]) expect(await all('event: x\r\ndata: 1\r\n\r\ndata: 2\r\n\r\n', chunk)).toEqual([{ event: 'x', data: '1' }, { data: '2' }]);
});

test('multi-line data, comments and unknown fields', async () => {
  expect(await all(': keep-alive\ndata: a\nid: 7\ndata: b\nretry: 100\n\n:\n\n')).toEqual([{ data: 'a\nb' }]);
});

test('only the first space after the colon is dropped; a bare field is empty', async () => {
  expect(await all('data:no-space\n\ndata:   two spaces\n\ndata\n\n')).toEqual([{ data: 'no-space' }, { data: '  two spaces' }, { data: '' }]);
});

test('event resets after each message, and an event without data is dropped', async () => {
  expect(await all('event: ping\n\ndata: plain\n\nevent: a\ndata: x\n\ndata: y\n\n')).toEqual([{ data: 'plain' }, { event: 'a', data: 'x' }, { data: 'y' }]);
});

test('multi-byte characters split across chunks', async () => {
  for (const chunk of [1, 2, 3]) expect(await all('data: สวัสดี 🙂\n\n', chunk)).toEqual([{ data: 'สวัสดี 🙂' }]);
});

test('a body that ends without a blank line still yields its data', async () => {
  expect(await all('data: one\n\ndata: [DONE]')).toEqual([{ data: 'one' }, { data: '[DONE]' }]);
  expect(await all('data: last\n')).toEqual([{ data: 'last' }]);
  expect(await all('')).toEqual([]);
});

test('messages are yielded as they arrive, before the body ends', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const enc = new TextEncoder();
  let step = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (step === 0) c.enqueue(enc.encode('data: first\n\n'));
      else if (step === 1) {
        await gate;
        c.enqueue(enc.encode('data: second\n\n'));
      } else c.close();
      step++;
    },
  });
  const it = readSse(body);
  const first = await Promise.race([it.next(), new Promise((r) => setTimeout(() => r('timeout'), 500))]);
  expect(first).toEqual({ value: { data: 'first' }, done: false });
  release();
  expect((await it.next()).value).toEqual({ data: 'second' });
  expect((await it.next()).done).toBe(true);
});
