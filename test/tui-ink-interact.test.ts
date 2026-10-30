import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/clients/tui-ink/app.tsx';
import { acceptTrust } from '../src/clients/tui-ink/onboarding.ts';
import type { TuiArgs } from '../src/clients/tui-ink/args.ts';
import { inkRenderOptions } from '../src/clients/tui-ink/render-options.ts';
import { ThreadStore, threadsDir } from '../src/core/project/threads.ts';
import { wordmark } from '../src/clients/tui-ink/splash.ts';
import { projectKey } from '../src/core/session/log.ts';

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
  // Everything written so far, escapes and all.
  raw: () => string;
  drain: () => void;
  stop: () => void;
};

const savedEnv: Record<string, string | undefined> = {};
let harnessCount = 0;

// before: sets up the project (threads, logs) once the directory exists, and may add to the args.
function start(opts: { rows?: number; script?: unknown[]; files?: string[]; before?: (dir: string, home: string) => Record<string, unknown> | void } = {}): Harness {
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
    ...(opts.before?.(dir, home) ?? {}),
  } as unknown as TuiArgs;
  // Tests accumulate stdout and assert on the concatenated buffer. Ink's
  // Frame-diff only writes changed rows, which would garble that buffer — keep
  // full-frame paints in the harness; production still uses incrementalRendering.
  const { unmount } = render(React.createElement(App, { args }), inkRenderOptions({
    stdin: stdin as unknown as NodeJS.ReadableStream,
    stdout,
    interactive: true,
    incrementalRendering: false,
  }));
  return {
    dir,
    write: (s: string) => {
      stdin.write(s);
    },
    // Only the latest screenful: ink repaints the whole screen each frame,
    // so the tail is the current frame without earlier history.
    frame: () => strip(out),
    raw: () => out,
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
      expect(h.frame()).toMatch(/✓ Done in \d+\.\ds/);
    } finally {
      h.stop();
    }
  });

  test('a turn shows one row per call, a blocked call, and the line that ends it', async () => {
    const h = start({
      files: ['notes.txt'],
      script: [
        { blocks: [
          { type: 'thinking', text: 'look first' },
          { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'notes.txt' } },
          { type: 'tool_use', id: 'c2', name: 'edit', input: { path: 'notes.txt', edits: [{ old_text: 'x', new_text: 'y' }] } },
        ] },
        { blocks: [{ type: 'text', text: '## Result\n\n- `notes.txt` read' }] },
      ],
    });
    try {
      await Bun.sleep(500);
      h.write('look');
      await Bun.sleep(300);
      h.write('\r');
      for (let i = 0; i < 40 && !h.frame().includes('✓ Done'); i++) await Bun.sleep(250);
      // Close the denial notice, then open the command menu.
      h.write('\x1b');
      await Bun.sleep(300);
      h.drain();
      h.write('/');
      await Bun.sleep(600);
      const f = h.frame();
      expect(f).toContain('∴ Thought');
      expect(f).toContain('✓ Read  notes.txt · 1 line');
      // read-only mode: the edit is denied before it starts, and its row says so.
      expect(f).toContain('✗ Edit  notes.txt · blocked');
      expect(f).toContain('• notes.txt read');
      expect(f).not.toContain('## Result');
      expect(f).toMatch(/✓ Done in \d+\.\ds · 1 tool · \$/);
      // The command menu opens over the transcript and the prompt panel keeps its three rows: padding, the
      // prompt, padding, all behind its bar.
      expect(f).toContain('/actions');
      expect(f).toMatch(/▌\s*\n\s*▌ › \/\s*\n\s*▌\s*\n/);
    } finally {
      h.stop();
    }
  });

  test('a on a denial notice adds its allow rule to the user settings, and the notice closes', async () => {
    let home = '';
    const h = start({
      files: ['notes.txt'],
      script: [
        { blocks: [{ type: 'tool_use', id: 'c1', name: 'edit', input: { path: 'notes.txt', edits: [{ old_text: 'x', new_text: 'y' }] } }] },
        { blocks: [{ type: 'text', text: 'blocked, carrying on' }] },
      ],
      before: (_dir, hm) => {
        home = hm;
      },
    });
    try {
      await Bun.sleep(500);
      h.write('change it');
      await Bun.sleep(300);
      h.write('\r');
      for (let i = 0; i < 40 && !h.frame().includes('✓ Done'); i++) await Bun.sleep(250);
      expect(h.frame()).toContain('allow edit(notes.txt) from your next message');
      h.drain();
      h.write('a');
      for (let i = 0; i < 20 && !h.frame().includes('allowed edit(notes.txt)'); i++) await Bun.sleep(150);
      expect(h.frame()).toContain('allowed edit(notes.txt) in ~/.cedia/settings.json');
      expect(h.frame()).not.toContain('✗ Blocked');
      expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).permissions.allow).toEqual(['edit(notes.txt)']);
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
  test('/model lists auto and oplan, and /model auto keeps the writer and names the mode', async () => {
    const h = start();
    try {
      await Bun.sleep(500);
      h.write('/model');
      await Bun.sleep(400);
      h.write('\x1b');
      await Bun.sleep(300);
      h.write('\r');
      await Bun.sleep(600);
      expect(h.frame()).toContain('auto  Auto: plans and reviews');
      expect(h.frame()).toContain('oplan  Oplan:');
      h.write('\x1b');
      await Bun.sleep(400);
      h.write('/model auto');
      await Bun.sleep(400);
      h.write('\x1b');
      await Bun.sleep(300);
      h.write('\r');
      await Bun.sleep(600);
      expect(h.frame()).toMatch(/the next turn runs in auto mode on \S+/);
      expect(h.frame()).toContain('· auto');
      // oplan needs roles.plan, and none is set here: it says so instead of failing the next turn.
      h.write('/model oplan');
      await Bun.sleep(400);
      h.write('\x1b');
      await Bun.sleep(300);
      h.write('\r');
      await Bun.sleep(600);
      expect(h.frame()).toContain('oplan plans with roles.plan');
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
      // PageUp twice: at 10 rows the transcript shows three rows, and one page moves four messages.
      h.write('\x1b[5~');
      await Bun.sleep(300);
      h.drain();
      h.write('\x1b[5~');
      await Bun.sleep(500);
      const up = h.frame();
      expect(up).toContain('more below');
      expect(up).toContain('q0');
      h.drain();
      h.write('\x1b[6~'); // PageDown, twice, returns to the bottom
      await Bun.sleep(300);
      h.drain();
      h.write('\x1b[6~');
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
  test('the prompt takes Thai and emoji, a held backspace, alt+enter and a bracketed paste', async () => {
    const h = start();
    try {
      await Bun.sleep(500);
      h.write('สวัสดี 🎉 abc');
      await Bun.sleep(300);
      // One chunk of three backspaces, as a held key sends them: each one counts.
      h.write('\x7f\x7f\x7f');
      await Bun.sleep(400);
      h.drain();
      h.write('\x1b\r');
      await Bun.sleep(200);
      h.write('next');
      await Bun.sleep(400);
      const typedFrame = h.frame();
      expect(typedFrame).toContain('› สวัสดี 🎉');
      expect(typedFrame).not.toContain('abc');
      expect(typedFrame).toMatch(/▌ {3}next/);
      // A paste with newlines stays in the prompt; it does not submit its first line.
      h.drain();
      h.write('\x1b[200~one\rtwo\x1b[201~');
      await Bun.sleep(400);
      const pasted = h.frame();
      expect(pasted).toContain('nextone');
      expect(pasted).toMatch(/▌ {3}two/);
      // Nothing was sent: no prompt row (its bar without the prompt's ›) in the transcript.
      expect(pasted).not.toMatch(/▌ สวัสดี/);
      // A long paste shows as a token.
      h.drain();
      h.write(`\x1b[200~${Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n')}\x1b[201~`);
      await Bun.sleep(400);
      expect(h.frame()).toContain('[Pasted text #1 +30 lines]');
    } finally {
      h.stop();
    }
  }, 30000);
  test('a prompt sent during a turn waits for it, and esc puts it back in the prompt', async () => {
    const h = start({ script: [{ hang: true }] });
    try {
      await Bun.sleep(500);
      h.write('first');
      await Bun.sleep(200);
      h.write('\r');
      await Bun.sleep(600);
      h.write('later');
      await Bun.sleep(200);
      h.write('\r');
      await Bun.sleep(400);
      expect(h.frame()).toContain('⧗ later');
      h.drain();
      h.write('\x1b');
      for (let i = 0; i < 20 && !h.frame().includes('› later'); i++) await Bun.sleep(200);
      expect(h.frame()).toContain('› later');
      // One more key paints a fresh frame: the queue line is gone from it.
      h.drain();
      h.write('!');
      await Bun.sleep(400);
      const back = h.frame();
      expect(back).toContain('› later!');
      expect(back).not.toContain('⧗ later');
    } finally {
      h.stop();
    }
  }, 30000);

  test('ctrl+c on an empty prompt asks for a second press before leaving', async () => {
    const h = start();
    try {
      await Bun.sleep(500);
      h.drain();
      h.write('\x03');
      await Bun.sleep(300);
      expect(h.frame()).toContain('Press Ctrl+C again to exit');
    } finally {
      h.stop();
    }
  }, 30000);
  test('a waiting prompt runs when the turn ends and leaves the draft being typed alone', async () => {
    const h = start({
      script: [
        { blocks: [{ type: 'tool_use', id: 's1', name: 'sleep', input: { duration_ms: 1500 } }] },
        { blocks: [{ type: 'text', text: 'answered' }] },
      ],
    });
    try {
      await Bun.sleep(500);
      h.write('first');
      await Bun.sleep(200);
      h.write('\r');
      await Bun.sleep(400);
      h.write('second');
      await Bun.sleep(200);
      h.write('\r');
      await Bun.sleep(200);
      h.write('draft');
      // Each turn reads the script afresh, so the second one sleeps and answers too.
      const secondDone = () => /▌ second[\s\S]*✓ Done/.test(h.frame());
      for (let i = 0; i < 40 && !secondDone(); i++) await Bun.sleep(250);
      expect(secondDone()).toBe(true);
      h.drain();
      h.write('!');
      await Bun.sleep(400);
      expect(h.frame()).toContain('› draft!');
    } finally {
      h.stop();
    }
  }, 30000);

  test('a turn that ends while the terminal is in the background sends a notification, and not while it has focus', async () => {
    const saved = { TERM_PROGRAM: process.env.TERM_PROGRAM, TMUX: process.env.TMUX, KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID };
    process.env.TERM_PROGRAM = 'iTerm.app';
    delete process.env.TMUX;
    delete process.env.KITTY_WINDOW_ID;
    const h = start({ script: [{ blocks: [{ type: 'text', text: 'first reply' }] }] });
    try {
      await Bun.sleep(500);
      // The TUI asks the terminal for focus reports.
      expect(h.raw()).toContain('\x1b[?1004h');
      h.write('\x1b[O');
      await Bun.sleep(100);
      h.write('one');
      await Bun.sleep(300);
      h.write('\r');
      for (let i = 0; i < 40 && !h.frame().includes('first reply'); i++) await Bun.sleep(250);
      await Bun.sleep(300);
      expect(h.raw()).toMatch(/\x1b\]9;cedia: Done in \d+s\x07/);
      // Back in front: the next turn ends without one.
      h.drain();
      h.write('\x1b[I');
      await Bun.sleep(100);
      h.write('two');
      await Bun.sleep(300);
      h.write('\r');
      // Each run replays the script from its start: the second turn has ended once two end lines show.
      const ended = () => (h.frame().split('▌ two')[1] ?? '').includes('✓ Done');
      for (let i = 0; i < 40 && !ended(); i++) await Bun.sleep(250);
      await Bun.sleep(300);
      expect(ended()).toBe(true);
      expect(h.raw()).not.toContain('\x1b]9;');
    } finally {
      h.stop();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }, 30000);

  test('a ! prompt runs in the shell, shows as a Bash row and its output goes with the next prompt', async () => {
    const h = start({ script: [{ blocks: [{ type: 'text', text: 'seen it' }] }] });
    try {
      await Bun.sleep(500);
      h.write('!echo hi-from-shell');
      await Bun.sleep(300);
      // The prompt says it is a shell command.
      expect(h.frame()).toContain('$ !echo hi-from-shell');
      h.write('\r');
      for (let i = 0; i < 40 && !h.frame().includes('goes with your next message'); i++) await Bun.sleep(100);
      expect(h.frame()).toMatch(/✓ Bash\s+echo hi-from-shell/);
      expect(h.frame()).toContain('└ hi-from-shell');
      h.write('what did it say');
      await Bun.sleep(300);
      h.write('\r');
      for (let i = 0; i < 40 && !h.frame().includes('seen it'); i++) await Bun.sleep(250);
      const store = new ThreadStore(threadsDir(join(h.dir, 'home'), projectKey(h.dir)));
      const prompts = store.list().flatMap((t) => t.runs.map((r) => r.prompt));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('<owner-shell>\n$ echo hi-from-shell\n(exit 0)\nhi-from-shell\n</owner-shell>');
      expect(prompts[0]!.endsWith('what did it say')).toBe(true);
    } finally {
      h.stop();
    }
  }, 30000);

  test('/agents opens the sub-thread view, ← → step between sub-threads and Esc goes back', async () => {
    const h = start({
      before: (dir, home) => {
        const store = new ThreadStore(threadsDir(home, projectKey(dir)));
        const parent = store.open('split the parser work');
        const a = store.open('port the lexer', { parent, now: new Date(Date.now() - 60_000) });
        const b = store.open('write parser tests', { parent, now: new Date(Date.now() - 30_000) });
        const log = join(dir, 'b.jsonl');
        writeFileSync(log, [
          { id: 'e1', parentId: null, at: '2026-01-01T00:00:00Z', kind: 'tool_intent', callId: 'c1', tool: 'read', input: { path: 'src/parser.ts' } },
          { id: 'e2', parentId: 'e1', at: '2026-01-01T00:00:01Z', kind: 'tool_result', callId: 'c1', status: 'done', output: { text: 'x' } },
          { id: 'e3', parentId: 'e2', at: '2026-01-01T00:00:02Z', kind: 'tool_intent', callId: 'c2', tool: 'bash', input: { command: 'bun test parser' } },
        ].map((e) => JSON.stringify(e)).join('\n') + '\n');
        store.append(a, { kind: 'state', state: 'done', result: 'lexer ported, 12 tests pass' });
        store.append(b, { kind: 'session', sessionId: 's-b', model: 'faux', role: 'code', why: 'start', path: log });
        store.append(b, { kind: 'todo', items: [{ text: 'list the cases', state: 'done' }, { text: 'write them', state: 'doing' }] });
        return { thread: parent };
      },
    });
    try {
      await Bun.sleep(500);
      h.write('/agents');
      await Bun.sleep(300);
      h.write('\x1b');
      await Bun.sleep(200);
      h.write('\r');
      await Bun.sleep(600);
      // It opens on the one still working, with its steps and its latest calls (the last still running).
      let f = h.frame();
      expect(f).toContain('Sub-thread 2 of 2');
      expect(f).toContain('write parser tests');
      expect(f).toContain('◐ write them');
      expect(f).toMatch(/✓ Read\s+src\/parser\.ts/);
      expect(f).toMatch(/● Bash\s+bun test parser/);
      expect(f).toContain('← → other sub-threads');
      h.drain();
      h.write('\x1b[C');
      await Bun.sleep(400);
      f = h.frame();
      expect(f).toContain('Sub-thread 1 of 2');
      expect(f).toContain('port the lexer');
      expect(f).toContain('lexer ported, 12 tests pass');
      h.drain();
      h.write('\x1b');
      await Bun.sleep(400);
      expect(h.frame()).not.toContain('Sub-thread 1 of 2');
    } finally {
      h.stop();
    }
  }, 30000);

  test('the first screen shows the wordmark; a prompt replaces it and sits in a panel of its own', async () => {
    const h = start({ script: [{ blocks: [{ type: 'text', text: 'hi there' }] }] });
    try {
      await Bun.sleep(500);
      const first = h.frame();
      expect(first).toContain(wordmark()[1]!);
      expect(first).toContain('! shell');
      h.drain();
      h.write('hello');
      await Bun.sleep(300);
      h.write('\r');
      for (let i = 0; i < 40 && !h.frame().includes('✓ Done'); i++) await Bun.sleep(250);
      // The newest frame: it starts at the one-line header that takes the splash's place.
      const f = h.frame().slice(h.frame().lastIndexOf('◆ cedia ·'));
      expect(f).not.toContain(wordmark()[1]!);
      // The prompt: its bar on a row of padding, its text, and padding again; the reply two columns in, under it.
      expect(f).toMatch(/ ▌ *\n ▌ hello *\n ▌ *\n\n {3}hi there/);
    } finally {
      h.stop();
    }
  }, 30000);

  test('a wheel step moves a long reply a few rows, and the screen stays full', async () => {
    const reply = Array.from({ length: 60 }, (_, i) => `row ${i}`).join('\n\n');
    const h = start({ rows: 30, script: [{ blocks: [{ type: 'text', text: reply }] }] });
    try {
      for (const p of ['one', 'two', 'three']) {
        h.write(p);
        await Bun.sleep(80);
        h.write('\r');
        await Bun.sleep(900);
      }
      h.drain();
      h.write('\x1b[<64;10;10M');
      await Bun.sleep(400);
      const f = h.frame();
      const screen = f.slice(f.lastIndexOf('◆ cedia ·')).split('\n');
      expect(screen[1]).toMatch(/more above/);
      // Three rows went below the screen: the last row of the reply, not the one before it.
      const shown = screen.join('\n');
      expect(shown).not.toMatch(/row 59\b/);
      expect(shown).toMatch(/row 58\b/);
      expect(shown).toMatch(/more below/);
      // The top of the screen is the same reply, with no blank band where its start would be.
      expect(screen.slice(2).findIndex((l) => l.trim())).toBeLessThanOrEqual(1);
    } finally {
      h.stop();
    }
  }, 30000);

  test('the wheel reaches the start of a reply taller than the screen, and stops at the top', async () => {
    const reply = Array.from({ length: 60 }, (_, i) => `row ${i}`).join('\n\n');
    const h = start({ rows: 30, script: [{ blocks: [{ type: 'text', text: reply }] }] });
    try {
      h.write('one');
      await Bun.sleep(80);
      h.write('\r');
      await Bun.sleep(900);
      for (let i = 0; i < 60; i++) {
        h.write('\x1b[<64;10;10M');
        await Bun.sleep(15);
      }
      await Bun.sleep(400);
      const f = h.frame();
      const screen = f.slice(f.lastIndexOf('◆ cedia ·'));
      expect(screen).toMatch(/row 0\b/);
      expect(screen).toMatch(/one/);
      expect(screen).not.toMatch(/more above/);
    } finally {
      h.stop();
    }
  }, 30000);
});
