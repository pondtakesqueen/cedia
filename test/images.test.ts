import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMessages } from '../src/core/context/build.ts';
import { blobDir, imageBase64, imageProblem, MAX_IMAGES_PER_SESSION, sniffImage, storeImage, type ImageRef } from '../src/core/images.ts';
import { imagesShown } from '../src/core/loop/run.ts';
import { anthropicBody } from '../src/core/providers/anthropic.ts';
import { resolveModel } from '../src/core/providers/catalog.ts';
import { chatBody } from '../src/core/providers/chat.ts';
import { responsesBody } from '../src/core/providers/responses.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { readTool } from '../src/core/tools/read.ts';
import type { Message, SessionEvent, WireRequest } from '../src/core/types.ts';

// Headers only: enough for each format's size fields, padded so the readers have the bytes they look at.
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function gif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  new DataView(b.buffer).setUint16(6, w, true);
  new DataView(b.buffer).setUint16(8, h, true);
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, an APP0 segment of 16 bytes, then SOF0 with height and width.
  const b = new Uint8Array(64);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  new DataView(b.buffer).setUint16(25, h);
  new DataView(b.buffer).setUint16(27, w);
  return b;
}
function webp(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)));
  b.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
  const put24 = (i: number, v: number) => b.set([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff], i);
  put24(24, w - 1);
  put24(27, h - 1);
  return b;
}

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-img-'));
  process.env.CEDIA_HOME = dir;
  return dir;
};

describe('images', () => {
  test('the format and size come from the header, never the name', () => {
    expect(sniffImage(png(1920, 1080))).toEqual({ mime: 'image/png', width: 1920, height: 1080 });
    expect(sniffImage(gif(320, 200))).toEqual({ mime: 'image/gif', width: 320, height: 200 });
    expect(sniffImage(jpeg(800, 600))).toEqual({ mime: 'image/jpeg', width: 800, height: 600 });
    expect(sniffImage(webp(2576, 1449))).toEqual({ mime: 'image/webp', width: 2576, height: 1449 });
    expect(sniffImage(new TextEncoder().encode('just text, not an image at all'))).toBeUndefined();
    expect(sniffImage(png(1, 1).subarray(0, 10))).toBeUndefined();
  });

  test('images the API would refuse are refused before they are stored', () => {
    expect(imageProblem({ width: 8001, height: 10, bytes: 100 })).toContain('8000 px');
    expect(imageProblem({ width: 10, height: 10, bytes: 9 * 1024 * 1024 })).toContain('MB');
    expect(imageProblem({ width: 0, height: 10, bytes: 100 })).toContain('cannot be read');
    const h = home();
    expect(storeImage(png(9000, 10), 'big.png', h)).toEqual({ error: expect.stringContaining('8000 px') });
    expect(existsBlobs(h)).toBe(0);
  });

  test('stored once by hash, readable by the user only, and checked against the hash when sent', () => {
    const h = home();
    const bytes = png(100, 50);
    const ref = storeImage(bytes, 'a.png', h) as ImageRef;
    expect(ref).toMatchObject({ mime: 'image/png', width: 100, height: 50, bytes: bytes.length, name: 'a.png' });
    expect(storeImage(bytes, 'again.png', h)).toMatchObject({ sha256: ref.sha256 });
    expect(existsBlobs(h)).toBe(1);
    expect(statSync(join(blobDir(h), ref.sha256)).mode & 0o777).toBe(0o600);
    expect(imageBase64(ref, h)).toBe(Buffer.from(bytes).toString('base64'));
    const other = png(100, 51);
    const ref2 = storeImage(other, 'b.png', h) as ImageRef;
    writeFileSync(join(blobDir(h), ref2.sha256), png(1, 1));
    expect(() => imageBase64(ref2, h)).toThrow('does not match its hash');
  });

  test('read shows an image as an image, and a text file as lines', async () => {
    home();
    const dir = mkdtempSync(join(tmpdir(), 'cedia-img-cwd-'));
    writeFileSync(join(dir, 'shot.png'), png(640, 480));
    writeFileSync(join(dir, 'notes.txt'), 'hello\n');
    const ctx = { cwd: dir, signal: new AbortController().signal };
    const img = await readTool.run({ path: 'shot.png' }, ctx);
    expect(img).toMatchObject({ isError: false, text: 'shot.png: png image, 640x480 px', images: [{ mime: 'image/png', width: 640, height: 480 }] });
    const txt = await readTool.run({ path: 'notes.txt' }, ctx);
    expect(txt.images).toBeUndefined();
    expect(txt.text).toContain('hello');
    writeFileSync(join(dir, 'huge.png'), png(9000, 9000));
    expect(await readTool.run({ path: 'huge.png' }, ctx)).toMatchObject({ isError: true, text: expect.stringContaining('8000 px') });
  });

  test('images go before the prompt text, and with a tool result into its content', () => {
    const h = home();
    const ref = storeImage(png(10, 10), 'x.png', h) as ImageRef;
    const log = SessionLog.create();
    log.append({ kind: 'user', text: 'what is wrong here?', images: [ref] });
    log.append({ kind: 'assistant', wire: 'anthropic-messages', model: 'm', blocks: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x.png' } }], stop: 'tool_use', usage: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
    log.append({ kind: 'tool_result', callId: 't1', status: 'completed', output: { text: 'x.png: png image, 10x10 px', isError: false, images: [ref] } });
    const messages = buildMessages(log.events);
    expect((messages[0] as Extract<Message, { role: 'user' }>).parts.map((p) => p.type)).toEqual(['image', 'text']);

    const data = Buffer.from(png(10, 10)).toString('base64');
    const a = anthropicBody(request('anthropic/claude-haiku-5-5', messages)) as any;
    expect(a.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    expect(a.messages[0].content[1]).toEqual({ type: 'text', text: 'what is wrong here?' });
    expect(a.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x.png: png image, 10x10 px' }, { type: 'image', source: { data } }] });
    // The same events give the same bytes, so the prefix stays cached.
    expect(JSON.stringify(anthropicBody(request('anthropic/claude-haiku-5-5', buildMessages(log.events))))).toBe(JSON.stringify(a));

    // Models that read only text are told what was there instead.
    const c = chatBody(request('opencode-go/deepseek-v4.1-flash', messages)) as any;
    expect(JSON.stringify(c)).not.toContain(data);
    expect(c.messages[1].content).toContain('[image x.png: png, 10x10 px, not shown: this model reads text only]');
    expect(c.messages.find((m: any) => m.role === 'tool').content).toContain('not shown: this model reads text only');
    const r = responsesBody(request('opencode-go/grok-4.7', messages)) as any;
    expect(JSON.stringify(r)).not.toContain(data);
    expect(JSON.stringify(r)).toContain('not shown: this model reads text only');
  });

  test('a session counts the images it has shown', () => {
    const ref = { sha256: 'x', mime: 'image/png', width: 1, height: 1, bytes: 1 } as ImageRef;
    const events = [
      { kind: 'user', text: 'a', images: [ref, ref] },
      { kind: 'tool_result', callId: 'c', status: 'completed', output: { text: '', isError: false, images: [ref] } },
      { kind: 'tool_result', callId: 'd', status: 'completed', output: { text: '', isError: false } },
    ] as SessionEvent[];
    expect(imagesShown(events)).toBe(3);
    expect(MAX_IMAGES_PER_SESSION).toBe(20);
  });
});

const existsBlobs = (h: string) => {
  try {
    return readdirSync(blobDir(h)).length;
  } catch {
    return 0;
  }
};

function request(ref: string, messages: Message[]): WireRequest {
  return { model: resolveModel(ref), sessionId: 's', system: 'sys', tools: [], messages, maxTokens: 100 };
}
