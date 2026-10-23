import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome } from './config.ts';

// An image a model is shown: the bytes live once in cedia's blob store, by hash, and the session log holds this
// reference, so a request rebuilt from the log sends the same bytes (cache rule 1) and the log says exactly what
// the model saw.
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export type ImageRef = { sha256: string; mime: ImageMime; width: number; height: number; bytes: number; name?: string };

// The Claude API's limits: 8000 px a side and 10 MB of base64 an image; past 20 images in a request every image
// must be at most 2000 px, so a session shows at most 20 (build/vision docs, 2026-10-23).
export const MAX_IMAGE_SIDE = 8000;
export const MAX_IMAGE_BYTES = Math.floor((10 * 1024 * 1024 * 3) / 4);
export const MAX_IMAGES_PER_SESSION = 20;

export const blobDir = (home = cediaHome()) => join(home, 'blobs');

// The format and size from the file's own header, never from its name. Undefined when it is not an image a
// model reads (or the header is cut short).
export function sniffImage(b: Uint8Array): { mime: ImageMime; width: number; height: number } | undefined {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') return { mime: 'image/png', width: u32be(16), height: u32be(20) };
  if (b.length >= 10 && ascii(0, 4) === 'GIF8') return { mime: 'image/gif', width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return undefined;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the markers to the first start-of-frame, which holds the size.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { mime: 'image/jpeg', width: u16be(i + 7), height: u16be(i + 5) };
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}

// Why the API would refuse this image, or undefined when it takes it.
export function imageProblem(ref: Pick<ImageRef, 'width' | 'height' | 'bytes'>): string | undefined {
  if (!ref.width || !ref.height) return 'its size cannot be read from its header';
  if (ref.width > MAX_IMAGE_SIDE || ref.height > MAX_IMAGE_SIDE) return `it is ${ref.width}x${ref.height} px; the limit is ${MAX_IMAGE_SIDE} px a side`;
  if (ref.bytes > MAX_IMAGE_BYTES) return `it is ${(ref.bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)} MB`;
  return undefined;
}

// Keeps the bytes in the blob store (readable by the user only) and returns the reference the log holds.
export function storeImage(bytes: Uint8Array, name?: string, home = cediaHome()): ImageRef | { error: string } {
  const head = sniffImage(bytes);
  if (!head) return { error: 'not a PNG, JPEG, GIF or WebP image' };
  const ref: ImageRef = { sha256: createHash('sha256').update(bytes).digest('hex'), ...head, bytes: bytes.length, ...(name ? { name } : {}) };
  const problem = imageProblem(ref);
  if (problem) return { error: problem };
  const dir = blobDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, ref.sha256);
  if (!existsSync(path)) {
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return ref;
}

const loaded = new Map<string, string>();

// The image's bytes as base64, checked against its hash, so a changed blob can never reach a model as the image
// the log names.
export function imageBase64(ref: ImageRef, home = cediaHome()): string {
  const hit = loaded.get(ref.sha256);
  if (hit) return hit;
  const bytes = readFileSync(join(blobDir(home), ref.sha256));
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error(`image ${ref.sha256} in ${blobDir(home)} does not match its hash`);
  const data = bytes.toString('base64');
  loaded.set(ref.sha256, data);
  return data;
}

// What a model that reads only text is told in an image's place.
export const imageNote = (ref: ImageRef) =>
  `[image${ref.name ? ` ${ref.name}` : ''}: ${ref.mime.slice(6)}, ${ref.width}x${ref.height} px, not shown: this model reads text only]`;

// A tool result's text with a note for each image, for a wire whose models read text only (Chat Completions and
// Responses in cedia's catalog).
export const withImageNotes = (text: string, images?: ImageRef[]) => (images?.length ? [text, ...images.map(imageNote)].filter(Boolean).join('\n') : text);

// The line a task gets for the images that came with it, so a role that only gets text (plan and review in the
// user's Claude Code) can open them.
export const attachedNote = (paths: string[]) => `The owner attached ${paths.length === 1 ? 'an image' : `${paths.length} images`}; open ${paths.length === 1 ? 'it' : 'them'} with your read tool to look: ${paths.join(', ')}`;
