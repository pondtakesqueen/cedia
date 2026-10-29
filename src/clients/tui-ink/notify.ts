// Telling the owner a turn wants them while they look elsewhere. The terminal reports focus (DECSET 1004: it
// sends ESC [ I on focus and ESC [ O on blur); a turn that ends while the terminal is blurred sends a desktop
// notification where the terminal has an escape for one, and a bell elsewhere. A terminal that never reported
// focus gets one only after a long turn, since the owner has likely gone off by then.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// auto: a notification where the terminal has one, else a bell. bell: the bell only. off: nothing.
export type NotifyMode = 'auto' | 'bell' | 'off';
export const NOTIFY_MODES: readonly NotifyMode[] = ['auto', 'bell', 'off'];
export type Focus = 'unknown' | 'focused' | 'blurred';
// osc9: iTerm2, WezTerm, Ghostty. osc99: kitty. osc777: foot, urxvt, Konsole and VTE terminals that read it.
export type Channel = 'osc9' | 'osc99' | 'osc777' | 'bell';

export const FOCUS_ON = '\x1b[?1004h';
export const FOCUS_OFF = '\x1b[?1004l';
// A turn at least this long notifies even when the terminal never said whether it has focus.
export const UNKNOWN_FOCUS_MS = 30_000;

export function resolveNotifyMode(raw: unknown): NotifyMode {
  return raw === 'bell' || raw === 'off' ? raw : 'auto';
}

export function notifyModeFrom(home: string): NotifyMode {
  try {
    const p = join(home, 'settings.json');
    if (existsSync(p)) return resolveNotifyMode((JSON.parse(readFileSync(p, 'utf8')) as { notify?: unknown }).notify);
  } catch {}
  return 'auto';
}

/** The focus the newest report in `data` says, if it has one. */
export function focusFrom(data: string): Focus | undefined {
  const i = data.lastIndexOf('\x1b[I');
  const o = data.lastIndexOf('\x1b[O');
  if (i < 0 && o < 0) return undefined;
  return i > o ? 'focused' : 'blurred';
}

export function channelFor(mode: NotifyMode, env: NodeJS.ProcessEnv = process.env): Channel {
  // tmux drops an OSC it does not know unless passthrough is on; it does pass the bell on as a window alert.
  if (mode === 'bell' || env.TMUX) return 'bell';
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'osc99';
  const program = env.TERM_PROGRAM ?? '';
  if (program === 'iTerm.app' || program === 'WezTerm' || program === 'ghostty') return 'osc9';
  if (env.TERM === 'foot' || env.TERM?.startsWith('rxvt') || env.KONSOLE_VERSION || env.VTE_VERSION) return 'osc777';
  return 'bell';
}

export function shouldNotify(mode: NotifyMode, focus: Focus, turnMs: number): boolean {
  if (mode === 'off' || focus === 'focused') return false;
  return focus === 'blurred' || turnMs >= UNKNOWN_FOCUS_MS;
}

// An escape sequence must not carry control characters of its own, and 777 splits its fields at ';'.
const clean = (s: string, n: number) => {
  const one = s.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function notifySequence(channel: Channel, title: string, body: string): string {
  const t = clean(title, 60);
  const b = clean(body, 200);
  switch (channel) {
    case 'osc9': return `\x1b]9;${t}: ${b}\x07`;
    case 'osc777': return `\x1b]777;notify;${t.replace(/;/g, ',')};${b.replace(/;/g, ',')}\x07`;
    case 'osc99': return `\x1b]99;i=1:d=0;${t}\x1b\\\x1b]99;i=1:p=body;${b}\x1b\\`;
    case 'bell': return '\x07';
  }
}

/** What a turn that ended this way says, or nothing when the owner ended it. */
export function turnNotice(subtype: string, ms: number, question?: string): string | undefined {
  if (subtype === 'interrupted') return undefined;
  const took = `${Math.round(ms / 1000)}s`;
  if (subtype === 'success' || subtype === 'handoff') return `Done in ${took}`;
  if (subtype === 'asked') return question ? `Asks: ${question}` : 'Waiting for your answer';
  return `Ended (${subtype.replace(/_/g, ' ')}) after ${took}`;
}
