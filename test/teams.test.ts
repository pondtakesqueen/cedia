import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamStore } from '../src/core/project/teams.ts';
import { effectOf } from '../src/core/tools/registry.ts';
import { teamTool } from '../src/core/tools/team.ts';

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

  test('an id from the model never names a file outside the teams directory', () => {
    const fs = require('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'cedia-teams-'));
    const home = join(dir, '.home');
    fs.mkdirSync(home, { recursive: true });
    const outside = join(home, 'settings.json');
    const body = JSON.stringify({ id: 'x', name: 'x', createdAt: '', tasks: [] });
    fs.writeFileSync(outside, body);
    const store = new TeamStore(home);
    expect(store.get('../settings')).toBeUndefined();
    expect(store.addTask('../settings', 'planted')).toBeUndefined();
    expect(store.delete('../settings')).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe(body);
  });

  test('listing and reading a team is a read; changing one is a write a read-only session may not make', () => {
    const tool = teamTool(new TeamStore(mkdtempSync(join(tmpdir(), 'cedia-teams-'))), 't-1');
    expect(effectOf(tool, { action: 'list' })).toBe('read');
    expect(effectOf(tool, { action: 'get', team: 'x' })).toBe('read');
    for (const action of ['create', 'add', 'set-status']) expect(effectOf(tool, { action })).toBe('write_workspace');
  });
});
