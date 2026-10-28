import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childThreads, recentCalls, subthreadLines } from '../src/clients/tui-ink/subthreads.ts';
import { rowText } from '../src/clients/tui-ink/rows.ts';
import { ThreadStore } from '../src/core/project/threads.ts';
import { findCommand, resolveBindings } from '../src/clients/tui-ink/keybindings/resolver.ts';

const event = (n: number, body: Record<string, unknown>) => JSON.stringify({ id: `e${n}`, parentId: null, at: '2026-01-01T00:00:00Z', ...body });

describe('the sub-thread view (subthreads.ts)', () => {
  test('lists only this thread\'s sub-threads, in the order they were opened', () => {
    const store = new ThreadStore(mkdtempSync(join(tmpdir(), 'cedia-sub-')));
    const parent = store.open('parent');
    const other = store.open('other');
    const second = store.open('second', { parent, now: new Date('2026-01-02T00:00:00Z') });
    const first = store.open('first', { parent, now: new Date('2026-01-01T00:00:00Z') });
    store.open('elsewhere', { parent: other });
    // A message to the first makes it the newest; the order stays.
    store.send(first, 'user', 'hi', new Date('2026-01-03T00:00:00Z'));
    expect(childThreads(store.list(), parent).map((t) => t.id)).toEqual([first, second]);
  });

  test('the latest calls come from the end of the session log, a call with no result still running', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-sub-'));
    const log = join(dir, 's.jsonl');
    const lines = [event(0, { kind: 'request' })];
    for (let i = 1; i <= 8; i++) {
      lines.push(event(i * 10, { kind: 'tool_intent', callId: `c${i}`, tool: 'read', input: { path: `f${i}.ts` } }));
      if (i < 8) lines.push(event(i * 10 + 1, { kind: 'tool_result', callId: `c${i}`, status: 'done', output: { text: '', isError: i === 7 } }));
    }
    writeFileSync(log, lines.join('\n') + '\n');
    const calls = recentCalls(log);
    expect(calls.map((c) => (c.input as { path: string }).path)).toEqual(['f3.ts', 'f4.ts', 'f5.ts', 'f6.ts', 'f7.ts', 'f8.ts']);
    expect(calls.map((c) => c.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'err', 'running']);
    expect(recentCalls(join(dir, 'missing.jsonl'))).toEqual([]);
    expect(recentCalls(undefined)).toEqual([]);
    // A log bigger than the part read: the cut first line is skipped, the end still read.
    writeFileSync(log, `${'x'.repeat(300 * 1024)}\n${lines.join('\n')}\n`);
    expect(recentCalls(log)).toHaveLength(6);
  });

  test('shows the state, the open question and the result, and keeps the newest when the screen is short', () => {
    const store = new ThreadStore(mkdtempSync(join(tmpdir(), 'cedia-sub-')));
    const id = store.open('port the lexer to the new token type');
    store.append(id, { kind: 'todo', items: [{ text: 'a', state: 'done' }, { text: 'b', state: 'doing' }, { text: 'c', state: 'pending' }] });
    store.append(id, { kind: 'question', sessionId: 's', question: 'Keep the old API?' });
    store.append(id, { kind: 'state', state: 'asking' });
    const asking = rowText(subthreadLines(store.read(id), { at: 0, of: 3 }, [], 80, 30));
    expect(asking).toContain('Sub-thread 1 of 3  port the lexer to the new token type');
    expect(asking).toContain('asking you');
    expect(asking).toContain('? Keep the old API?');
    expect(asking).toContain('✓ a\n  ◐ b\n  ○ c');
    store.append(id, { kind: 'state', state: 'done', result: 'one\ntwo\nthree\nfour\nfive\nsix' });
    const done = rowText(subthreadLines(store.read(id), { at: 0, of: 1 }, [{ tool: 'edit', input: { path: 'lex.ts' }, state: 'ok' }], 80, 30));
    expect(done).toContain('done');
    expect(done).toContain('✓ Edit  lex.ts');
    expect(done).toContain('  four\n  … 2 more lines');
    // Six rows: the head and the end of the result.
    const short = subthreadLines(store.read(id), { at: 0, of: 1 }, [], 80, 6);
    expect(short).toHaveLength(6);
    expect(rowText(short)).toContain('… 2 more lines');
    expect(rowText(short)).not.toContain('◐ b');
  });

  test('← → step, ↑ and Esc go back, Enter goes on with it', () => {
    const b = resolveBindings([]);
    expect(findCommand(b, 'left', 'Task')).toBe('prev');
    expect(findCommand(b, 'right', 'Task')).toBe('next');
    expect(findCommand(b, 'up', 'Task')).toBe('close');
    expect(findCommand(b, 'escape', 'Task')).toBe('close');
    expect(findCommand(b, 'enter', 'Task')).toBe('accept');
  });
});
