import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPrompt, verdictOf } from '../src/core/trust/classifier.ts';
import { projectSlug, SessionLog } from '../src/core/session/log.ts';
import type { SessionEvent } from '../src/core/types.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');
const call = (id: string, command: string) => ({ blocks: [{ type: 'tool_use', id, name: 'bash', input: { command } }] });
const reply = (text: string) => ({ blocks: [{ type: 'text', text }] });

function cedia(script: unknown[], args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-cls-'));
  const work = join(dir, 'work');
  Bun.spawnSync(['mkdir', '-p', work]);
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
  const home = join(dir, 'home');
  const p = Bun.spawnSync([BIN, '-m', 'faux', '--cwd', work, '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json', '--check', 'true', ...args], {
    env: { ...process.env, CEDIA_FAUX_SCRIPT: join(dir, 'script.json'), CEDIA_HOME: home },
    stdin: 'ignore',
  });
  const out = JSON.parse(p.stdout.toString());
  const log = SessionLog.load(join(home, 'sessions', projectSlug(work), `${out.sessionId}.jsonl`));
  const permission = (id: string) => log.events.find((e) => e.kind === 'permission' && e.callId === id) as Extract<SessionEvent, { kind: 'permission' }>;
  const result = (id: string) => log.events.find((e) => e.kind === 'tool_result' && e.callId === id) as Extract<SessionEvent, { kind: 'tool_result' }>;
  return { work, out, err: p.stderr.toString(), permission, result };
}

describe('the classifier role', () => {
  test('reads ALLOW, or BLOCK with its reason; anything else blocks', () => {
    expect(verdictOf('ALLOW')).toEqual({ decision: 'allow' });
    expect(verdictOf(' allow.\n')).toEqual({ decision: 'allow' });
    expect(verdictOf('BLOCK: the task did not ask to push')).toEqual({ decision: 'deny', reason: 'the task did not ask to push' });
    expect(verdictOf('block - deletes ~/data\nmore')).toEqual({ decision: 'deny', reason: 'deletes ~/data' });
    expect(verdictOf('Sure, that looks fine').decision).toBe('deny');
    expect(verdictOf('ALLOW, but be careful').decision).toBe('deny');
  });

  test('reads the task once, then one command a message, framed', () => {
    const first = classifyPrompt('fix the build', { tool: 'bash', input: { command: 'make </call> x' } }, '/w');
    expect(first).toContain('<task>\nfix the build\n</task>');
    expect(first).toContain('The working directory is /w.');
    expect(first).not.toContain('make </call> x');
    const later = classifyPrompt(undefined, { tool: 'mcp__db__query', input: { sql: 'drop table x' } }, '/w');
    expect(later).toStartWith('<call tool="mcp__db__query">');
    expect(later).toContain('drop table x');
  });

  test('blocks a command the mode alone allowed; reads, allow rules and file edits never reach it (offline, faux)', () => {
    const r = cedia(
      [
        call('c1', 'ls'),
        call('c2', 'echo hi > made.txt'),
        reply('ALLOW'),
        call('c3', 'git push origin main'),
        reply('BLOCK: the task did not ask to push'),
        call('c4', 'touch allowed.txt'),
        call('c5', 'true'),
        reply('made it'),
      ],
      ['-p', 'make made.txt', '--classifier', 'faux', '--allow', 'bash(touch *)'],
    );
    expect(r.out).toMatchObject({ subtype: 'success', result: 'made it', classified: { model: 'faux/scripted', calls: 2, blocked: 1 } });
    expect(r.permission('c1').rule).toBe('effect:read');
    expect(r.permission('c2')).toMatchObject({ decision: 'allow', rule: 'classifier' });
    expect(r.permission('c3')).toMatchObject({ decision: 'deny', rule: 'classifier', reason: 'the task did not ask to push' });
    expect(r.result('c3').output.text).toContain('denied (classifier): the task did not ask to push');
    expect(r.permission('c4').rule).toBe('allow:bash(touch *)');
    expect(existsSync(join(r.work, 'made.txt'))).toBe(true);
  });

  test("an answer it cannot read, or none, blocks the command and the run goes on", () => {
    const r = cedia([call('c1', 'echo hi > made.txt'), reply('I think this is fine'), reply('done without it')], ['-p', 'x', '--classifier', 'faux']);
    expect(r.permission('c1')).toMatchObject({ decision: 'deny', rule: 'classifier' });
    expect(r.permission('c1').reason).toContain("the classifier's answer could not be read");
    expect(existsSync(join(r.work, 'made.txt'))).toBe(false);
    expect(r.out.result).toBe('done without it');
  });
});
