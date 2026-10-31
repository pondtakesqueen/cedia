import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('cedia -h defaults', () => {
  test('the code, review, and handoff lines match the code', () => {
    const env = { ...process.env };
    delete env.CEDIA_FAUX_SCRIPT;
    delete env.CEDIA_MODEL;
    const p = spawnSync(resolve(import.meta.dir, '../bin/cedia'), ['-h'], { encoding: 'utf8', env });
    expect(p.status).toBe(0);
    const out = p.stdout;
    expect(out).toContain('roles.code in settings, haiku)');
    expect(out).toContain('(default opus at medium there)');
    expect(out).not.toContain('default sonnet there');
    expect(out).toContain('default: settings, compact)');
    expect(out).not.toContain('default: settings, note)');
  });
});
