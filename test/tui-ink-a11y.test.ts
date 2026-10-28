import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { envScreenReader, selectedPrefix } from '../src/clients/tui-ink/a11y.ts';
import { DISMISS_NOTE, PermissionDialog } from '../src/clients/tui-ink/permission-dialogs.tsx';
import { INK_THEMES } from '../src/clients/tui-ink/theme-tokens.ts';
import { StatusBar } from '../src/clients/tui-ink/status-bar.tsx';
import { inkRenderOptions } from '../src/clients/tui-ink/render-options.ts';

const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\([0-9A-Z]/g, '');

const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ['CEDIA_SCREEN_READER', 'CEDIA_AX_SCREEN_READER', 'INK_SCREEN_READER']) {
    if (k in saved) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
      delete saved[k];
    }
  }
});

function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe('ink a11y', () => {
  test('envScreenReader reads cedia and ink flags', () => {
    setEnv('CEDIA_SCREEN_READER', undefined);
    setEnv('CEDIA_AX_SCREEN_READER', undefined);
    setEnv('INK_SCREEN_READER', undefined);
    expect(envScreenReader()).toBe(false);
    setEnv('CEDIA_SCREEN_READER', '1');
    expect(envScreenReader()).toBe(true);
    setEnv('CEDIA_SCREEN_READER', undefined);
    setEnv('CEDIA_AX_SCREEN_READER', '1');
    expect(envScreenReader()).toBe(true);
    setEnv('CEDIA_AX_SCREEN_READER', undefined);
    setEnv('INK_SCREEN_READER', 'true');
    expect(envScreenReader()).toBe(true);
  });

  test('selectedPrefix speaks selected for screen readers', () => {
    expect(selectedPrefix(true, false)).toBe('› ');
    expect(selectedPrefix(false, false)).toBe('  ');
    expect(selectedPrefix(true, true)).toBe('selected: ');
    expect(selectedPrefix(false, true)).toBe('');
  });

  test('inkRenderOptions enables Ink SR when the env flag is set', () => {
    setEnv('CEDIA_SCREEN_READER', '1');
    expect(inkRenderOptions().isScreenReaderEnabled).toBe(true);
    setEnv('CEDIA_SCREEN_READER', undefined);
    expect(inkRenderOptions().isScreenReaderEnabled).toBeUndefined();
  });

  test('PermissionDialog in SR mode drops box borders and keeps spoken fields', async () => {
    let out = '';
    const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
    stdout.columns = 80;
    stdout.rows = 24;
    stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const { unmount } = render(React.createElement(PermissionDialog, {
      tool: 'edit',
      input: { path: 'a.ts', old_text: 'foo', new_text: 'bar' },
      reason: 'blocked',
      rule: 'read-only',
    }), {
      stdout,
      exitOnCtrlC: false,
      interactive: true,
      isScreenReaderEnabled: true,
      incrementalRendering: false,
    });
    await Bun.sleep(200);
    unmount();
    const text = strip(out);
    expect(text).toContain('edit denied');
    expect(text).toContain('path: a.ts');
    expect(text).toContain('- foo');
    expect(text).toContain('+ bar');
    expect(text).toContain(DISMISS_NOTE);
    // Box-drawing / brand chrome must not be spoken.
    expect(text).not.toMatch(/[┌┐└┘│─]/);
    expect(text).not.toContain('██');
  });

  test('StatusBar stays plain text under SR', async () => {
    let out = '';
    const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
    stdout.columns = 80;
    stdout.rows = 4;
    stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const { unmount } = render(React.createElement(StatusBar, {
      T: INK_THEMES.dark,
      mode: 'workspace',
      modeColor: INK_THEMES.dark.primary,
      model: 'Sonnet 5.5',
      effort: 'high',
      tokens: 1200,
      windowSize: 200_000,
      spend: 0.12,
      vimMode: 'normal',
    }), {
      stdout,
      exitOnCtrlC: false,
      interactive: true,
      isScreenReaderEnabled: true,
      incrementalRendering: false,
    });
    await Bun.sleep(150);
    unmount();
    const text = strip(out);
    expect(text).toContain('mode workspace');
    expect(text).toContain('effort high');
    expect(text).toContain('vim normal');
    expect(text).toContain('context 1%');
    expect(text).toContain('$0.12');
    expect(text).not.toMatch(/[▰▱◐]/);
    expect(text).not.toMatch(/[┌┐└┘│─]/);
  });
});
