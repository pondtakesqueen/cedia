import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectUsage } from '../src/clients/tui-ink/usage-summary.ts';
import { visualSpan } from '../src/clients/tui-ink/vim-input.tsx';
import { clearYank, yankedText, yankText } from '../src/clients/tui-ink/yank.ts';
import { projectKey } from '../src/core/session/log.ts';
import type { SessionEvent, Usage } from '../src/core/types.ts';

afterEach(() => {
  clearYank();
});

const at = (s: number) => new Date(Date.UTC(2026, 9, 22, 0, 0, s)).toISOString();
const usage = (cacheRead: number, uncached: number, output = 10): Usage => ({ uncached, cacheRead, cacheWrite: 0, output });

describe('ink usage summary', () => {
  test('loadProjectUsage ranks models by cost from session logs', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-usage-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-proj-'));
    const dir = join(home, 'sessions', projectKey(cwd));
    mkdirSync(dir, { recursive: true });
    let n = 0;
    const e = (body: Record<string, unknown>, s = n): SessionEvent =>
      ({ id: `e${n++}`, at: at(s), ...body }) as unknown as SessionEvent;
    const haiku = 'anthropic/claude-haiku-5-5';
    const events: SessionEvent[] = [
      e({ kind: 'session', cwd, role: 'code', model: haiku, system: 'S', tools: [] }),
      e({ kind: 'user', text: 'hi' }),
      e({ kind: 'request', model: haiku, toolsHash: 't', systemHash: 's', bodyHash: 'b1', headers: {} }, 1),
      e({ kind: 'assistant', wire: 'anthropic', model: haiku, blocks: [{ type: 'text', text: 'ok' }], stop: 'end_turn', usage: usage(0, 2000) }, 2),
      e({ kind: 'request', model: haiku, toolsHash: 't', systemHash: 's', bodyHash: 'b2', headers: {} }, 3),
      e({ kind: 'assistant', wire: 'anthropic', model: haiku, blocks: [{ type: 'text', text: 'again' }], stop: 'end_turn', usage: usage(0, 1000) }, 4),
    ];
    writeFileSync(join(dir, 's1.jsonl'), events.map((ev) => JSON.stringify(ev)).join('\n') + '\n');
    const summary = loadProjectUsage(cwd, home);
    expect(summary).not.toBeNull();
    expect(summary!.sessions).toBe(1);
    expect(summary!.requests).toBeGreaterThanOrEqual(1);
    expect(summary!.models[0]!.model).toBe(haiku);
    expect(summary!.models[0]!.costUsd).toBeGreaterThan(0);
    expect(summary!.models[0]!.requests).toBeGreaterThanOrEqual(1);
  });

  test('loadProjectUsage returns null when there are no logs', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-usage-empty-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cedia-proj-empty-'));
    expect(loadProjectUsage(cwd, home)).toBeNull();
  });
});

describe('ink vim visual helpers', () => {
  test('visualSpan covers characters in visual and whole lines in vline', () => {
    const text = 'aa\nbbb\ncc';
    expect(visualSpan(text, 'visual', 1, 4)).toEqual({ lo: 1, hi: 5 });
    expect(visualSpan(text, 'vline', 1, 4)).toEqual({ lo: 0, hi: 7 }); // through end of "bbb\n"
    expect(visualSpan(text, 'vline', 0, 0)).toEqual({ lo: 0, hi: 3 }); // "aa\n"
    expect(visualSpan(text, 'insert', 0, 1)).toBeNull();
  });

  test('yank register stores and returns text', () => {
    expect(yankedText()).toBe('');
    yankText('hello');
    expect(yankedText()).toBe('hello');
    yankText('world\n');
    expect(yankedText()).toBe('world\n');
  });
});
