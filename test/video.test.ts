import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMedia } from '../src/core/config.ts';
import { resolveModel } from '../src/core/providers/catalog.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { readTool } from '../src/core/tools/read.ts';
import type { SessionEvent } from '../src/core/types.ts';
import { formatTime, MAX_VIDEO_FRAMES, sniffVideo, spread, storeAttachment, videoFrames } from '../src/core/video.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const header = (bytes: number[]) => {
  const b = new Uint8Array(64);
  b.set(bytes);
  return b;
};
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every((bin) => {
  try {
    return Bun.spawnSync([bin, '-version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  } catch {
    return false;
  }
});

// A white 1440x900 screen where a small box appears at 2 s and another at 4 s: what a screen recording of a bug
// looks like to the frame picker (one line of a page changing).
function recording(dir: string, seconds = 6): string {
  const path = join(dir, 'rec.mp4');
  const boxes = "drawbox=x=100:y=100:w=40:h=14:color=black:t=fill:enable='gte(t,2)',drawbox=x=100:y=130:w=60:h=14:color=red:t=fill:enable='gte(t,4)'";
  const r = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=white:s=1440x900:d=${seconds},format=yuv420p`, '-vf', boxes, '-r', '30', path], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return path;
}

describe('video', () => {
  test('the container comes from the header, never the name', () => {
    expect(sniffVideo(header([0, 0, 0, 0x20, ...ascii('ftypisom')]))).toBe('video/mp4');
    expect(sniffVideo(header([0, 0, 0, 0x14, ...ascii('ftypqt  ')]))).toBe('video/quicktime');
    expect(sniffVideo(header([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...ascii('webm')]))).toBe('video/webm');
    expect(sniffVideo(header([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88, ...ascii('matroska')]))).toBe('video/x-matroska');
    expect(sniffVideo(header([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('AVI ')]))).toBe('video/x-msvideo');
    expect(sniffVideo(header([0x89, ...ascii('PNG')]))).toBeUndefined();
    expect(sniffVideo(header(ascii('hello world, not a video')))).toBeUndefined();
  });

  test('frames are spread from the first to the last', () => {
    expect(spread(3, 8)).toEqual([0, 1, 2]);
    expect(spread(100, 8)).toEqual([0, 14, 28, 42, 57, 71, 85, 99]);
    expect(spread(5, 1)).toEqual([0]);
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(83.25)).toBe('1:23.3');
  });

  test('a text-only code model sends a run with images to Haiku 5.5, or to --media; one that reads images keeps them', () => {
    process.env.CEDIA_HOME = tmp('cedia-media-');
    expect(loadMedia(resolveModel('deepseek'))?.ref).toBe('anthropic/claude-haiku-5-5');
    expect(loadMedia(resolveModel('deepseek'), 'sonnet')?.ref).toBe('anthropic/claude-sonnet-5-5');
    expect(loadMedia(resolveModel('deepseek'), 'none')).toBeUndefined();
    expect(loadMedia(resolveModel('sonnet'))).toBeUndefined();
    expect(() => loadMedia(resolveModel('deepseek'), 'deepseek-or')).toThrow('reads text only');
    expect(loadMedia(resolveModel('faux'))?.ref).toBe('faux/media');
  });

  test('a file that is neither says so', () => {
    const dir = tmp('cedia-vid-');
    process.env.CEDIA_HOME = join(dir, 'home');
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const got = storeAttachment(join(dir, 'notes.txt'), 'notes.txt');
    expect(got).toEqual({ error: 'not a PNG, JPEG, GIF or WebP image (nor an MP4, MOV, WebM, MKV or AVI video)' });
  });
});

describe.skipIf(!hasFfmpeg)('video with ffmpeg', () => {
  test('the frames are the first, each change on screen and the last, each named by its time', () => {
    const dir = tmp('cedia-vid-');
    const home = join(dir, 'home');
    const v = videoFrames(recording(dir), 'rec.mp4', { home });
    if ('error' in v) throw new Error(v.error);
    expect(v.mime).toBe('video/mp4');
    expect(v.durationSec).toBeCloseTo(6, 0);
    expect(v.times.map(Math.round)).toEqual([0, 2, 4, 6]);
    expect(v.frames.map((f) => f.name)).toEqual(['rec.mp4 @ 0:00.0', 'rec.mp4 @ 0:02.0', 'rec.mp4 @ 0:04.0', 'rec.mp4 @ 0:06.0']);
    // A Retina-sized screen is cut to the side the API keeps.
    expect(v.frames.every((f) => f.mime === 'image/jpeg' && f.width === 1440 && f.height === 900)).toBe(true);
    expect(readdirSync(join(home, 'blobs')).sort()).toEqual([...new Set(v.frames.map((f) => f.sha256))].sort());
  });

  test('a long recording that moves all the time gives at most 8 frames, spread over all of it', () => {
    const dir = tmp('cedia-vid-');
    const path = join(dir, 'long.mp4');
    expect(Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=2000x1250:d=60:r=5', '-preset', 'ultrafast', path]).exitCode).toBe(0);
    const v = videoFrames(path, 'long.mp4', { home: join(dir, 'home') });
    if ('error' in v) throw new Error(v.error);
    expect(v.frames).toHaveLength(MAX_VIDEO_FRAMES);
    expect(v.times[0]).toBe(0);
    expect(v.times.at(-1)!).toBeGreaterThan(55);
    expect(v.frames[0]!.width).toBe(1568);
  }, 60_000);

  test('read shows a video as its frames, with their times in the text', async () => {
    const dir = tmp('cedia-vid-');
    process.env.CEDIA_HOME = join(dir, 'home');
    recording(dir);
    const out = await readTool.run({ path: 'rec.mp4' }, { cwd: dir } as Parameters<typeof readTool.run>[1]);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/^rec\.mp4: mp4 video, 0:06\.\d long; 4 frames shown, at 0:00\.0, 0:02\.0, 0:04\.0, 0:06\.\d$/);
    expect(out.images).toHaveLength(4);
  });

  test('-p --image with a recording on a text-only model: its frames go to the media model, with what they show', () => {
    const dir = tmp('cedia-e2e-');
    const home = join(dir, 'home');
    recording(dir);
    writeFileSync(join(dir, 'script.json'), JSON.stringify([{ blocks: [{ type: 'text', text: 'the red box' }] }]));
    const run = (extra: string[]) => {
      const p = Bun.spawnSync([BIN, '-m', 'faux', '--cwd', dir, '-p', 'what goes wrong?', '--image', 'rec.mp4', '--output-format', 'json', ...extra], {
        env: { ...process.env, CEDIA_FAUX_SCRIPT: join(dir, 'script.json'), CEDIA_HOME: home },
        stdin: 'ignore',
      });
      return { code: p.exitCode, err: p.stderr.toString(), result: JSON.parse(p.stdout.toString() || '{}') };
    };
    const routed = run([]);
    expect(routed.code).toBe(0);
    expect(routed.err).toContain('cedia: faux/scripted reads text only; this run, which brings images, goes to faux/media');
    const sessions = join(home, 'sessions');
    const [project] = readdirSync(sessions);
    const [file] = readdirSync(join(sessions, project!));
    const events = SessionLog.load(join(sessions, project!, file!)).events;
    expect(events.find((e) => e.kind === 'session')).toMatchObject({ model: 'faux/media' });
    const user = events.find((e) => e.kind === 'user') as Extract<SessionEvent, { kind: 'user' }>;
    expect(user.images?.map((i) => i.name)).toEqual(['rec.mp4 @ 0:00.0', 'rec.mp4 @ 0:02.0', 'rec.mp4 @ 0:04.0', 'rec.mp4 @ 0:06.0']);
    expect(user.text).toContain(`The owner attached a file; open it with your read tool to look: ${join(dir, 'rec.mp4')}`);
    expect(user.text).toMatch(/rec\.mp4: mp4 video, 0:06\.\d long; 4 frames shown, at 0:00\.0, 0:02\.0, 0:04\.0, 0:06\.\d/);
    const kept = run(['--media', 'none']);
    expect(kept.code).toBe(0);
    expect(kept.err).not.toContain('reads text only');
  }, 30_000);
});
