import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAllowRules, suggestAllowRules } from '../src/core/safety/suggest.ts';
import type { SessionInput } from '../src/core/session/usage.ts';
import type { SessionEvent } from '../src/core/types.ts';

let n = 0;
const e = (body: Record<string, unknown>): SessionEvent => ({ id: `e${n++}`, at: new Date(Date.UTC(2026, 9, 22, 0, 0, n)).toISOString(), ...body }) as unknown as SessionEvent;
const use = (id: string, name: string, input: Record<string, unknown>) => e({ kind: 'assistant', wire: 'faux', model: 'm', blocks: [{ type: 'tool_use', id, name, input }], stop: 'tool_use', usage: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } });
const perm = (callId: string, tool: string, rule: string) => e({ kind: 'permission', callId, tool, decision: 'deny', rule });
const denied = (callId: string) => e({ kind: 'tool_result', callId, status: 'denied', output: { text: 'denied', isError: true } });
const session = (events: SessionEvent[]): SessionInput => ({ id: 's', events });

describe('permissions suggest', () => {
  test('proposes read-only bash and exact MCP tools, ranked; the rest is left out with reasons', () => {
    const events = [
      use('m1', 'mcp__srv__search', {}), perm('m1', 'mcp__srv__search', 'mode:read-only'), denied('m1'),
      use('m2', 'mcp__srv__search', {}), perm('m2', 'mcp__srv__search', 'mode:read-only'), denied('m2'),
      use('m3', 'mcp__srv__search', {}), perm('m3', 'mcp__srv__search', 'mode:read-only'), denied('m3'),
      use('b1', 'bash', { command: 'ls src' }), perm('b1', 'bash', 'mode:read-only'), denied('b1'),
      use('b2', 'bash', { command: 'rm -rf x' }), perm('b2', 'bash', 'mode:read-only'), denied('b2'),
      use('b3', 'bash', { command: 'ls blocked' }), perm('b3', 'bash', 'deny:bash(ls blocked)'), denied('b3'),
      use('e1', 'edit', { path: 'f.txt', edits: [] }), perm('e1', 'edit', 'mode:read-only'), denied('e1'),
    ];
    const r = suggestAllowRules([session(events)], { allow: [], deny: [] });
    expect(r.suggestions).toEqual([
      { rule: 'mcp__srv__search', hits: 3, example: 'mcp__srv__search', tool: 'mcp__srv__search' },
      { rule: 'bash(ls *)', hits: 1, example: 'ls src', tool: 'bash' },
    ]);
    expect([r.skippedDeny, r.skippedUnsafe, r.sessions]).toEqual([1, 2, 1]);
  });

  test('covered rules are not proposed; deny-held calls stay held', () => {
    const events = [use('m1', 'mcp__srv__search', {}), perm('m1', 'mcp__srv__search', 'mode:read-only'), denied('m1')];
    expect(suggestAllowRules([session(events)], { allow: ['mcp__srv__search'], deny: [] }).suggestions).toEqual([]);
    const r = suggestAllowRules([session(events)], { allow: [], deny: ['mcp__srv__search'] });
    expect(r.suggestions).toEqual([]);
    expect(r.skippedDeny).toBe(1);
  });

  test('apply writes missing rules to the user settings and nothing else', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-suggest-'));
    expect(applyAllowRules(home, ['bash(ls *)', 'mcp__srv__search']).added).toEqual(['bash(ls *)', 'mcp__srv__search']);
    const file = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    expect(file.permissions.allow).toEqual(['bash(ls *)', 'mcp__srv__search']);
    expect(applyAllowRules(home, ['bash(ls *)', 'bash(cat *)']).added).toEqual(['bash(cat *)']);
    writeFileSync(join(home, 'settings.json'), '{nope');
    expect(() => applyAllowRules(home, ['bash(x *)'])).toThrow('settings.json');
  });
});
