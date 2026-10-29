import { expect, test } from 'bun:test';
import { BUILTIN_PROFILES, resolveProfile, withProfile } from '../src/core/profiles.ts';

test('a profile is cedia\'s own with the user\'s laid over it, key by key', () => {
  expect(resolveProfile('coordinator')).toEqual(BUILTIN_PROFILES.coordinator!);
  expect(resolveProfile('coordinator', { coordinator: { ask: false, model: 'sonnet' } })).toMatchObject({ permission: 'read-only', openThread: true, ask: false, model: 'sonnet' });
  expect(resolveProfile('docs', { docs: { permission: 'workspace' } })).toEqual({ permission: 'workspace' });
  expect(() => resolveProfile('nope', { docs: {} })).toThrow('no profile "nope" (known: coordinator, ci, docs)');
  expect(resolveProfile('ci')).toMatchObject({ permission: 'workspace', planWhen: 'never' });
  expect(resolveProfile('ci').instructions).toContain('Never skip, disable, loosen or delete a test');
  expect(() => resolveProfile('docs', { docs: { planWhen: 'sometimes' } })).toThrow('profiles.docs.planWhen must be auto, always or never');
  expect(() => resolveProfile('a b')).toThrow('a profile name is 1 to 32 letters');
  expect(() => resolveProfile('docs', { docs: { permission: 'root' } })).toThrow('profiles.docs.permission must be read-only or workspace');
  expect(() => resolveProfile('docs', { docs: { todo: 'yes' } })).toThrow('profiles.docs.todo must be true or false');
  expect(() => resolveProfile('docs', { docs: [] })).toThrow('profiles.docs must be an object');
});

test('the profile fills only what the flags left out', () => {
  const p = { model: 'sonnet', permission: 'read-only' as const, ask: true, todo: false, spawn: 'worktree' as const };
  expect(withProfile<{ prompt: string; model?: string; permission?: string; ask?: string; todo?: string; spawn?: string }>({ prompt: 'x', model: 'haiku' }, p)).toEqual({ prompt: 'x', model: 'haiku', permission: 'read-only', ask: 'on', todo: 'off', spawn: 'worktree' });
  expect(withProfile<{ prompt: string; ask?: string }>({ prompt: 'x', ask: 'off' }, {})).toEqual({ prompt: 'x', ask: 'off' });
  expect(withProfile<{ prompt: string; planWhen?: string }>({ prompt: 'x' }, { planWhen: 'never' })).toEqual({ prompt: 'x', planWhen: 'never' });
  expect(withProfile<{ prompt: string; planWhen?: string }>({ prompt: 'x', planWhen: 'always' }, { planWhen: 'never' })).toEqual({ prompt: 'x', planWhen: 'always' });
});
