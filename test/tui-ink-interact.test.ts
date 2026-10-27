import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/clients/tui-ink/app.tsx';
import { acceptTrust } from '../src/clients/tui-ink/onboarding.ts';
import type { TuiArgs } from '../src/clients/tui-ink/args.ts';

const strip = (s: string) =>
  s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\([0-9A-Z]/g, '')
    .replace(/\x1b_[^\x07]*\x07/g, '')
    .replace(/\x1b[PX^][\s\S]*?\x1b\\/g, '');

type Harness = {
  dir: string;
  write: (s: string) => void;
  frame: () => string;
  drain: () => void;
  stop: () => void;
};

const savedEnv: Record<string, string | undefined> = {};
let harnessCount = 0;

function start(opts: { rows?: number; script?: unknown[]; files?: string[] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-ink-it-'));
  for (const f of opts.files ?? []) writeFileSync(join(dir, f), 'x\n');
  const home = join(dir, 'home');
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(opts.script ?? []));
  process.env.CEDIA_HOME = home;
  process.env.CEDIA_FAUX_SCRIPT = scriptPath;
  acceptTrust(home);
  const stdin = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => {};
  let out = '';
  const stdout = new PassThrough() as unknown as NodeJS.WritableStream & { columns: number; rows: number; isTTY: boolean };
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  stdout.columns = 100;
  stdout.rows = opts.rows ?? 30;
  (stdout as unknown as PassThrough).on('data', (d: Buffer) => {
    out += d.toString();
  });
  const args = {
    cwd: dir,
    model: 'faux',
    permission: 'read-only',
    planWhen: 'never',
    sandbox: 'off',
    spawn: 'off',
  } as unknown as TuiArgs;
  const { unmount } = render(React.createElement(App, { args }), {
    stdin: stdin as unknown as NodeJS.ReadableStream,
    stdout,
    exitOnCtrlC: false,
  });
  return {
    dir,
    write: (s: string) => {
      stdin.write(s);
    },
    // Only the latest screenful: ink repaints the whole screen each frame,
    // so the tail is the current frame without earlier history.
    frame: () => strip(out),
    drain: () => {
      out = '';
    },
    stop: () => {
      try {
        unmount();
      } catch {}
      try {
        (stdin as unknown as PassThrough).destroy();
      } catch {}
    },
  };
}

beforeEach(() => {
  harnessCount += 1;
  for (const k of ['CEDIA_HOME', 'CEDIA_FAUX_SCRIPT']) savedEnv[k + harnessCount] = process.env[k];
});

afterEach(() => {
  for (const k of ['CEDIA_HOME', 'CEDIA_FAUX_SCRIPT']) {
    const v = savedEnv[k + harnessCount];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k + harnessCount];
  }
});

describe('ink TUI interaction (fake terminal, faux model)', () => {
  test('typing / shows the command dropdown and filters as you type', async () => {
    const h = start();
    try {
      await Bun.sleep(500);
      h.write('/');
      await Bun.sleep(500);
      const f1 = h.frame();
      // Empty query matches everything, alphabetically first.
      expect(f1).toContain('/actions');
      h.write('s');
      await Bun.sleep(500);
      const f2 = h.frame();
      // Prefix matches for "s" rank first (search/settings/status/...).
      expect(f2).toMatch(/\/search|\/status/);
      // Esc dismisses; the typed text stays and stays editable.
      h.write('\x1b');
      await Bun.sleep(400);
      h.write('e');
      await Bun.sleep(500);
      const f3 = h.frame();
      expect(f3).toContain('/se');
    } finally {
      h.stop();
    }
  });

  test('@ mentions complete file paths from the working tree', async () => {
    const h = start({ files: ['hello-world.txt'] });
    try {
      await Bun.sleep(500);
      h.write('@hello');
      await Bun.sleep(500);
      expect(h.frame()).toContain('hello-world.txt');
    } finally {
      h.stop();
    }
  });

  test('a prompt runs a turn end to end and shows the reply', async () => {
    const h = start({ script: [{ blocks: [{ type: 'text', text: 'hello back' }] }] });
    try {
      await Bun.sleep(500);
      h.write('hi');
      await Bun.sleep(300);
      h.write('\r');
      for (let i = 0; i < 40 && !h.frame().includes('hello back'); i++) await Bun.sleep(250);
      expect(h.frame()).toContain('hello back');
      expect(h.frame()).toMatch(/done · \d+ turn/);
    } finally {
      h.stop();
    }
  });

  test('up recalls history in insert mode but not in normal mode', async () => {
    // Two turns so a stray history step would visibly change the recalled text.
    const h = start({ script: [{ blocks: [{ type: 'text', text: 'reply echo' }] }] });
    try {
      await Bun.sleep(500);
      for (const q of ['aaa-first', 'bbb-second']) {
        h.write(q);
        await Bun.sleep(200);
        h.write('\r');
        await Bun.sleep(4000);
      }
      // Insert mode: Up recalls the latest prompt into the editor row (› ).
      h.write('\x1b[A');
      await Bun.sleep(500);
      expect(h.frame()).toContain('› bbb-second');
      // Normal mode: Up moves the cursor instead of stepping through history,
      // so the editor keeps showing the same recalled prompt.
      h.write('\x1b'); // Esc: insert -> normal
      await Bun.sleep(400);
      h.write('\x1b[A');
      await Bun.sleep(500);
      expect(h.frame()).toContain('› bbb-second');
    } finally {
      h.stop();
    }
  }, 60000);

  test('settings panel opens, arrows switch tabs, esc closes', async () => {
    const h = start();
    try {
      await Bun.sleep(500);
      h.write('/settings');
      await Bun.sleep(500);
      h.write('\x1b'); // dismiss the autocomplete dropdown
      await Bun.sleep(400);
      h.write('\r'); // submit /settings
      await Bun.sleep(500);
      expect(h.frame()).toContain('Model');
      h.write('\x1b[C'); // Right: status -> config tab
      await Bun.sleep(500);
      expect(h.frame()).toContain('Search');
      h.write('\x1b'); // Esc closes the panel
      await Bun.sleep(500);
    } finally {
      h.stop();
    }
  }, 60000);
  test('scrolling reveals older and newer messages', async () => {
    // NOTE: headless re-reads CEDIA_FAUX_SCRIPT on every turn, so every turn
    // returns the same first step. Turns are serialized with fixed sleeps:
    // polling the frame for receipts cannot work because old receipts repaint
    // into every fresh frame. Faux turns finish in ~1s; 4s is ample margin.
    const h = start({ rows: 10, script: [{ blocks: [{ type: 'text', text: 'reply echo' }] }] });
    try {
      await Bun.sleep(500);
      for (let t = 0; t < 3; t++) {
        h.write(`q${t}`);
        await Bun.sleep(200);
        h.write('\r');
        await Bun.sleep(4000);
      }
      // Overflow pushes the earliest turns above the window.
      expect(h.frame()).toContain('more above');
      // Drain so the assertions below only see post-scroll repaints.
      h.drain();
      h.write('\x1b[5~'); // PageUp
      await Bun.sleep(500);
      const up = h.frame();
      expect(up).toContain('more below');
      expect(up).toContain('q0');
      h.drain();
      h.write('\x1b[6~'); // PageDown returns to the bottom
      await Bun.sleep(500);
      const down = h.frame();
      expect(down).toContain('q2');
      expect(down).toContain('reply echo');
      expect(down).not.toContain('more below');
    } finally {
      h.stop();
    }
  }, 60000);

  test('transcript search Enter jumps and keeps the query and the draft', async () => {
    const h = start({ script: [{ blocks: [{ type: 'text', text: 'hello back' }] }] });
    try {
      await Bun.sleep(500);
      h.write('hello there');
      await Bun.sleep(200);
      h.write('\r');
      for (let i = 0; i < 40 && !h.frame().includes('hello back'); i++) await Bun.sleep(250);
      h.write('draft-should-stay');
      await Bun.sleep(300);
      h.write('\x06');
      await Bun.sleep(300);
      h.drain();
      h.write('hello');
      await Bun.sleep(400);
      const highlighted = h.frame();
      expect(highlighted).toContain('search transcript: hello');
      expect(highlighted).toContain('hello back');
      expect(highlighted).not.toContain('│ hello there');
      h.drain();
      h.write('\x1b[B');
      await Bun.sleep(300);
      h.drain();
      h.write('\r');
      await Bun.sleep(500);
      const jumped = h.frame();
      expect(jumped).toContain('hello back');
      expect(jumped).toContain('1 more below');
      expect(jumped).toContain('search transcript: hello');
      expect(jumped).toContain('› draft-should-stay');
      h.drain();
      h.write('\x1b');
      await Bun.sleep(400);
      const closed = h.frame();
      expect(closed).not.toContain('search transcript');
      expect(closed).toContain('› draft-should-stay');
      expect(closed).toContain('hello back');
    } finally {
      h.stop();
    }
  }, 60000);
});
