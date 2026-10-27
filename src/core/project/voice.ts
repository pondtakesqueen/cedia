// Voice input (minimal). Records audio via ffmpeg (avfoundation on macOS, pulse on Linux) and transcribes
// via OpenAI's Whisper API (OPENAI_API_KEY) or a local `whisper` binary if installed.
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type VoiceResult = { text: string; error?: string };

function recordPath(): string {
  return join(tmpdir(), `cedia-voice-${Date.now()}.wav`);
}

export async function recordAudio(seconds = 5): Promise<string | { error: string }> {
  const out = recordPath();
  const platform = process.platform;
  const input = platform === 'darwin' ? ['-f', 'avfoundation', '-i', ':0'] : ['-f', 'pulse', '-i', 'default'];
  const args = ['-y', ...input, '-t', String(seconds), '-ar', '16000', '-ac', '1', out];
  try {
    const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', ...args], { stdout: 'ignore', stderr: 'pipe' });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      return { error: `ffmpeg failed: ${err.slice(0, 200)}` };
    }
    if (!existsSync(out)) return { error: 'no audio captured' };
    return out;
  } catch (e) {
    return { error: `ffmpeg not available: ${(e as Error).message}` };
  }
}

export async function transcribe(path: string): Promise<VoiceResult> {
  // local whisper binary
  if (Bun.which('whisper')) {
    try {
      const proc = Bun.spawn(['whisper', path, '--model', 'base', '--output_format', 'txt', '--output_dir', tmpdir()], { stdout: 'pipe', stderr: 'pipe' });
      await proc.exited;
      const txtPath = path.replace(/\.wav$/, '.txt');
      // whisper outputs to output_dir with basename
      const base = path.split('/').pop()!.replace(/\.wav$/, '');
      const out = join(tmpdir(), `${base}.txt`);
      if (existsSync(out)) {
        const text = await Bun.file(out).text();
        try { unlinkSync(out); } catch {}
        return { text: text.trim() };
      }
    } catch {}
  }
  // OpenAI Whisper API
  const key = process.env.OPENAI_API_KEY;
  if (key) {
    try {
      const form = new FormData();
      form.append('file', Bun.file(path), 'audio.wav');
      form.append('model', 'whisper-1');
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
      });
      if (!res.ok) return { text: '', error: `whisper api ${res.status}` };
      const data = (await res.json()) as { text?: string };
      return { text: (data.text ?? '').trim() };
    } catch (e) {
      return { text: '', error: (e as Error).message };
    }
  }
  return { text: '', error: 'no transcription backend (install whisper or set OPENAI_API_KEY)' };
}

export async function voiceInput(seconds = 5): Promise<VoiceResult> {
  const rec = await recordAudio(seconds);
  if (typeof rec !== 'string') return { text: '', error: rec.error };
  const tr = await transcribe(rec);
  try { unlinkSync(rec); } catch {}
  return tr;
}
