import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cediaHome } from './config.ts';
import { MAX_IMAGES_PER_SESSION, sniffImage, storeImage, type ImageRef } from './images.ts';

// A video a model is shown: frames taken with ffmpeg, each an image in the blob store like any other, named with
// the file and the time it shows. The video itself stays where it is; the text that goes with the frames names it.
export type VideoMime = 'video/mp4' | 'video/quicktime' | 'video/webm' | 'video/x-matroska' | 'video/x-msvideo';
export type VideoFrames = { mime: VideoMime; durationSec: number; frames: ImageRef[]; times: number[] };

// At most this many frames a video, so two recordings and a few screenshots still fit a session's 20 images.
export const MAX_VIDEO_FRAMES = 8;
// The long side of a frame: the Claude API shrinks anything past about 1.15 megapixels, and 1568 px is the side it
// keeps for a 1:1 image (build/vision docs), so a Retina recording costs no more than it can show.
export const FRAME_SIDE = 1568;
// Frames looked at for changes: four a second, fewer past 100 seconds.
const CANDIDATE_FPS = 4;
const MAX_CANDIDATES = 400;

// The container from the file's own header, never from its name. Undefined when it is not a video.
export function sniffVideo(b: Uint8Array): VideoMime | undefined {
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') return ascii(8, 2) === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ascii(0, Math.min(b.length, 64)).includes('webm') ? 'video/webm' : 'video/x-matroska';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return 'video/x-msvideo';
  return undefined;
}

// `count` of `n` indexes spread evenly from the first to the last.
export function spread(n: number, count: number): number[] {
  if (n <= count) return [...Array(n).keys()];
  if (count === 1) return [0];
  return [...new Set([...Array(count).keys()].map((i) => Math.round((i * (n - 1)) / (count - 1))))];
}

const ffmpegBin = () => process.env.CEDIA_FFMPEG ?? 'ffmpeg';
const ffprobeBin = () => process.env.CEDIA_FFPROBE ?? 'ffprobe';

export const formatTime = (sec: number) => {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
};

// The frames worth looking at: the first, each one where something on screen changes, and the last, spread down to `max`
// when there are more. Stored in the blob store, named `<name> @ m:ss.s`.
export function videoFrames(path: string, name = path, opts: { max?: number; home?: string } = {}): VideoFrames | { error: string } {
  const max = Math.max(1, Math.min(opts.max ?? MAX_VIDEO_FRAMES, MAX_IMAGES_PER_SESSION));
  let head: Uint8Array;
  try {
    head = fileHead(path);
  } catch (e) {
    return { error: `cannot read it: ${(e as Error).message}` };
  }
  const mime = sniffVideo(head);
  if (!mime) return { error: 'not an MP4, MOV, WebM, MKV or AVI video' };
  let probe;
  try {
    probe = Bun.spawnSync([ffprobeBin(), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  } catch {
    return { error: 'reading a video needs ffmpeg (ffprobe was not found)' };
  }
  if (probe.exitCode !== 0) return { error: `ffprobe could not read it: ${probe.stderr.toString().trim().split('\n').at(-1) ?? ''}` };
  const durationSec = Number(probe.stdout.toString().trim()) || 0;
  const dir = mkdtempSync(join(tmpdir(), 'cedia-frames-'));
  try {
    const scale = `scale=w='min(${FRAME_SIDE},iw)':h='min(${FRAME_SIDE},ih)':force_original_aspect_ratio=decrease`;
    // mpdecimate keeps a frame when any 8x8 block of it differs from the last one kept, so a screen recording's
    // one changed line counts; ffmpeg's scene score missed a 60x14 px box appearing on a 1440x900 screen.
    // showinfo prints each kept frame's time, in the order the files are written.
    // At most MAX_CANDIDATES looked at, spread over the whole video, so a long recording that moves all the time
    // is not cut off at its start.
    const rate = Math.min(CANDIDATE_FPS, durationSec > 0 ? MAX_CANDIDATES / durationSec : CANDIDATE_FPS);
    const select = `fps=${rate.toFixed(4)},mpdecimate,showinfo,${scale}`;
    const scenes = Bun.spawnSync([ffmpegBin(), '-hide_banner', '-nostdin', '-i', path, '-vf', select, '-fps_mode', 'vfr', '-frames:v', String(MAX_CANDIDATES), '-q:v', '3', join(dir, 's%04d.jpg')], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', timeout: 120_000 });
    if (scenes.exitCode !== 0) return { error: `ffmpeg could not take its frames: ${scenes.stderr.toString().trim().split('\n').at(-1) ?? ''}` };
    const times = [...scenes.stderr.toString().matchAll(/showinfo.*?pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    const files = readdirSync(dir).filter((f) => f.startsWith('s')).sort();
    const found = files.map((f, i) => ({ file: f, time: times[i] ?? 0 }));
    // The last frame, where a recording of a bug usually ends up, unless a change was kept just before it.
    if (durationSec > 0 && (found.at(-1)?.time ?? 0) < durationSec - 0.5) {
      const last = Bun.spawnSync([ffmpegBin(), '-hide_banner', '-nostdin', '-sseof', '-0.25', '-i', path, '-vf', scale, '-update', '1', '-q:v', '3', join(dir, 'last.jpg')], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', timeout: 60_000 });
      if (last.exitCode === 0 && readdirSync(dir).includes('last.jpg')) found.push({ file: 'last.jpg', time: durationSec });
    }
    if (!found.length) return { error: 'ffmpeg found no frames in it' };
    const kept = spread(found.length, max).map((i) => found[i]!);
    const frames: ImageRef[] = [];
    for (const f of kept) {
      const bytes = readFileSync(join(dir, f.file));
      if (!sniffImage(bytes)) continue;
      const ref = storeImage(bytes, `${name} @ ${formatTime(f.time)}`, opts.home ?? cediaHome());
      if ('error' in ref) return { error: `a frame at ${formatTime(f.time)}: ${ref.error}` };
      frames.push(ref);
    }
    return { mime, durationSec, frames, times: kept.map((f) => f.time) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What goes with a video's frames in the text: the file, how long it is, and the time each frame shows.
export const videoNote = (name: string, v: VideoFrames) =>
  `${name}: ${v.mime.slice(6)} video, ${formatTime(v.durationSec)} long; ${v.frames.length} frame${v.frames.length === 1 ? '' : 's'} shown, at ${v.times.map(formatTime).join(', ')}`;

// A file's first bytes, enough for either sniffer, without reading a long recording whole.
export function fileHead(path: string, n = 64): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const b = new Uint8Array(n);
    return b.subarray(0, readSync(fd, b, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

// An attachment the owner gave (--image, threads send --image): an image as it is, or a video as its frames.
export function storeAttachment(path: string, name = path, home = cediaHome()): { images: ImageRef[]; note?: string } | { error: string } {
  if (sniffVideo(fileHead(path))) {
    const v = videoFrames(path, name, { home });
    return 'error' in v ? v : { images: v.frames, note: videoNote(name, v) };
  }
  const ref = storeImage(readFileSync(path), name, home);
  return 'error' in ref ? { error: `${ref.error}${ref.error.startsWith('not a') ? ' (nor an MP4, MOV, WebM, MKV or AVI video)' : ''}` } : { images: [ref] };
}
