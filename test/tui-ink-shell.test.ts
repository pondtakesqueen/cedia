import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHELL_NOTE_CHARS, runOwnerShell, shellCommand, shellEnd, shellNote } from '../src/clients/tui-ink/shell.ts';

describe('`!` shell commands (shell.ts)', () => {
  test('only a prompt that starts with ! is one', () => {
    expect(shellCommand('!git status')).toBe('git status');
    expect(shellCommand('  ! ls -la ')).toBe('ls -la');
    expect(shellCommand('!')).toBe('');
    expect(shellCommand('why does !x fail')).toBeUndefined();
    expect(shellCommand('/help')).toBeUndefined();
  });

  test('runs in the working directory and keeps stdout, stderr and the exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-shell-'));
    const run = await runOwnerShell('pwd; echo oops >&2; printf "\\033[31mred\\033[0m\\n"; exit 3', dir, new AbortController().signal);
    expect(run.exitCode).toBe(3);
    expect(run.output).toContain(dir.split('/').pop()!);
    expect(run.output).toContain('[stderr]\noops');
    // Colors are the terminal's business, not the model's.
    expect(run.output).toContain('red');
    expect(run.output).not.toContain('\x1b[');
  });

  test('Esc stops a command, and a slow one ends at the time limit', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const t0 = Date.now();
    const stopped = await runOwnerShell('echo before; sleep 20; echo after', tmpdir(), stop.signal);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(stopped.ended).toBe('stopped');
    expect(stopped.exitCode).toBeNull();
    expect(stopped.output).toContain('before');
    expect(stopped.output).not.toContain('after');
    expect(shellEnd(stopped)).toBe('stopped by the owner');
    const slow = await runOwnerShell('sleep 20', tmpdir(), new AbortController().signal, 200);
    expect(slow.ended).toBe('timeout');
  });

  test('the note says the owner ran it, and keeps the end of a long output', () => {
    expect(shellNote([])).toBe('');
    const note = shellNote([
      { command: 'git status', exitCode: 0, output: 'clean', ms: 10 },
      { command: 'make', exitCode: 2, output: 'x'.repeat(SHELL_NOTE_CHARS) + 'THE END', ms: 10 },
    ]);
    expect(note).toContain('The owner ran these commands in their own shell');
    expect(note).toContain('$ git status\n(exit 0)\nclean');
    expect(note).toContain('$ make\n(exit 2)\n[… 7 earlier characters cut]');
    expect(note).toContain('THE END');
    expect(note.endsWith('</owner-shell>\n\n')).toBe(true);
  });
});
