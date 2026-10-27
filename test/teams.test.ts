import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamStore } from '../src/core/project/teams.ts';

describe('teams', () => {
  test('create, add task, update, delete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-teams-'));
    const home = join(dir, '.home');
    require('node:fs').mkdirSync(home, { recursive: true });
    const store = new TeamStore(home);
    const team = store.create('Demo');
    expect(team.name).toBe('Demo');
    const task = store.addTask(team.id, 'first', 'alice');
    expect(task?.title).toBe('first');
    const updated = store.updateTask(team.id, task!.id, { status: 'done' });
    expect(updated?.status).toBe('done');
    expect(store.list()).toHaveLength(1);
    expect(store.delete(team.id)).toBe(true);
    expect(store.get(team.id)).toBeUndefined();
  });
});
