import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { sniffImage, storeImage } from '../images.ts';
import { fileHead, sniffVideo, videoFrames, videoNote } from '../video.ts';
import { clip, type ToolSpec } from './registry.ts';

const MAX_LINES = 2000;

export const readTool: ToolSpec = {
  name: 'read',
  description:
    'Read a text file, look at an image (PNG, JPEG, GIF, WebP), or look at a video (MP4, MOV, WebM, MKV, AVI) as frames where its picture changes. Returns numbered lines. Use offset and limit for large files (default: first 2000 lines).',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      offset: { type: 'integer', description: '1-based line to start from' },
      limit: { type: 'integer', description: 'Number of lines to read' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  effect: 'read',
  pathOf: (input) => (typeof input.path === 'string' ? input.path : undefined),
  replay: 'safe',
  async run(input, ctx) {
    const path = String(input.path ?? '');
    if (!path) return { text: 'path is required', isError: true };
    const full = isAbsolute(path) ? path : resolve(ctx.cwd, path);
    let bytes: Buffer;
    try {
      if (statSync(full).isDirectory()) return { text: `${path} is a directory`, isError: true };
      if (sniffVideo(fileHead(full))) {
        const v = videoFrames(full, path);
        if ('error' in v) return { text: `cannot show ${path}: ${v.error}`, isError: true };
        return { text: videoNote(path, v), isError: false, images: v.frames };
      }
      bytes = readFileSync(full);
    } catch (e) {
      return { text: `cannot read ${path}: ${(e as Error).message}`, isError: true };
    }
    if (sniffImage(bytes)) {
      const image = storeImage(bytes, path);
      if ('error' in image) return { text: `cannot show ${path}: ${image.error}`, isError: true };
      return { text: `${path}: ${image.mime.slice(6)} image, ${image.width}x${image.height} px`, isError: false, images: [image] };
    }
    const content = bytes.toString('utf8');
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const start = Math.max(1, Number(input.offset ?? 1));
    const limit = Math.max(1, Math.min(Number(input.limit ?? MAX_LINES), MAX_LINES));
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join('\n');
    const more = start - 1 + slice.length < lines.length ? `\n[${lines.length - (start - 1 + slice.length)} more lines; use offset]` : '';
    return { text: clip(body + more) || '(empty file)', isError: false };
  },
};
