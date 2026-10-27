import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capEffort, loadMaxEffort } from '../src/core/config.ts';
import { ThreadStore } from '../src/core/project/threads.ts';
import { decide, ruleMatches, type Policy } from '../src/core/safety/policy.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import type { ToolSpec } from '../src/core/tools/registry.ts';

// spawnTool is a factory (needs a Spawner); the policy only reads name/pathOf, so a stub suffices here.
const spawnStub = { name: 'spawn' } as unknown as ToolSpec;

const cwd = mkdtempSync(join(tmpdir(), 'cedia-13-'));

describe('1: max-effort ceiling', () => {
  test('capEffort resolves levels above the ceiling down to it', () => {
    expect(capEffort('max', 'medium')).toBe('medium');
    expect(capEffort('low', 'medium')).toBe('low');
    expect(capEffort('high', undefined)).toBe('high');
    expect(capEffort(undefined, 'low')).toBeUndefined();
  });

  test('loadMaxEffort reads CEDIA_MAX_EFFORT and rejects unknown levels', () => {
    expect(loadMaxEffort({})).toBeUndefined();
    expect(loadMaxEffort({ CEDIA_MAX_EFFORT: 'low' })).toBe('low');
    expect(() => loadMaxEffort({ CEDIA_MAX_EFFORT: 'ultra' })).toThrow('maxEffort');
  });
});

describe('2: per-session summary sidecar', () => {
  test('a handoff writes <id>.summary.md; a rewind marks it; remove deletes both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-threads-'));
    const store = new ThreadStore(dir);
    const id = store.open('fix the login bug');
    store.append(id, { kind: 'session', sessionId: 's1', model: 'm', role: 'code', why: 'start' });
    expect(store.summary(id)).toBeUndefined();
    store.append(id, { kind: 'handoff', sessionId: 's1', note: 'done up to step 3\n' });
    expect(store.summary(id)).toContain('done up to step 3');
    store.append(id, { kind: 'rewind', run: 'r1' });
    expect(store.summary(id)).toContain('r1');
    store.remove(id);
    expect(store.summary(id)).toBeUndefined();
    expect(store.has(id)).toBe(false);
  });
});

describe('3: param-scoped Tool(param:value) rules', () => {
  const ws: Policy = { mode: 'workspace', allow: [], deny: ['spawn(kind:work)'] };
  test('a deny rule on spawn kind holds for work but not explore', () => {
    expect(decide(ws, spawnStub, { task: 'x', kind: 'work' }, cwd).decision).toBe('deny');
    expect(decide(ws, spawnStub, { task: 'x', kind: 'explore' }, cwd).decision).toBe('allow');
  });

  test('bash(command:…) matches the input value; a path with a colon still matches the classic way', () => {
    expect(ruleMatches('bash(command:rm *)', bashTool, { command: 'rm -rf x' }, cwd)).toBe(true);
    expect(ruleMatches('bash(command:rm *)', bashTool, { command: 'bun test' }, cwd)).toBe(false);
    expect(ruleMatches('bash(C:/x*)', bashTool, { command: 'echo hi' }, cwd)).toBe(false);
  });
});
