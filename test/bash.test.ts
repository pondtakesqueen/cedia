import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool, checkReadOnly } from '../src/core/tools/bash.ts';

describe('read-only bash policy', () => {
  const allowed = [
    'ls -la',
    'git status',
    'git log --oneline -5 | head -3',
    'grep -rn "a>b" src',
    "rg 'x;y' .",
    'find . -name "*.ts" | wc -l',
    'cat a.txt && wc -l a.txt',
    'ls missing 2>/dev/null || echo none',
    'git diff 2>&1 | head',
    "sed -n '1,20p' file.ts",
    'uniq -c sorted.txt',
    "awk '{print $1}' f",
    'rg --pre-glob "*.gz" x',
    'git grep -n needle',
  ];
  const refused = [
    'rm -rf /',
    'echo hi > out.txt',
    'cat a >> b',
    'ls; rm x',
    'ls & rm x',
    'echo $(whoami)',
    'echo `whoami`',
    'find . -delete',
    'find . -exec rm {} ;',
    "sed -i 's/a/b/' f",
    'git push --force',
    'git commit -m x',
    'git branch -D main',
    'git -c core.pager=sh log',
    'FOO=1 ls',
    'curl https://example.com',
    'sort -o out in',
    "awk 'BEGIN{system(\"rm x\")}'",
    // Ways the listed commands run another program or write a file.
    `awk 'BEGIN{"echo pwned > f" | getline x}'`,
    `awk 'BEGIN{print "x" |& "sh"}'`,
    'awk -f prog.awk data',
    'rg --pre sh hello .',
    'rg --pre=./run hello',
    'sort --compress-program=sh -S 1 big',
    'git grep -O sh needle',
    'git grep --open-files-in-pager=sh needle',
    'git show --textconv HEAD:a',
    'git diff --ext-diff',
    'date -s 2020-01-01',
    'tree -o out.txt',
    'tree -R -H . ',
    'file -C -m magic',
    'find . -fprint0 out',
    'uniq in.txt out.txt',
    'cat <(ls)',
    'ls "unclosed',
  ];
  for (const c of allowed) test(`allows: ${c}`, () => expect(checkReadOnly(c)).toEqual({ ok: true }));
  for (const c of refused) test(`refuses: ${c}`, () => expect(checkReadOnly(c).ok).toBe(false));
});

describe('running a command', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cedia-bash-'));
  const run = (command: string, opts: { timeout_ms?: number; signal?: AbortSignal } = {}) =>
    bashTool.run({ command, timeout_ms: opts.timeout_ms }, { cwd, signal: opts.signal ?? new AbortController().signal });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      // A killed child nobody reaped is a zombie: dead, but kill(0) still finds it.
      return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
    } catch {
      return false;
    }
  };

  test('a timeout ends the whole process group, not only bash', async () => {
    const t = performance.now();
    const r = await run('sleep 30 & echo $! > child.pid; wait', { timeout_ms: 300 });
    expect(performance.now() - t).toBeLessThan(5000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('timed out after 300 ms');
    const pid = Number(await Bun.file(join(cwd, 'child.pid')).text());
    await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  });

  test('an abort ends it too', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await run('sleep 30', { signal: ac.signal });
    expect(r.text).toContain('aborted');
  });

  test('a background job that keeps the pipes open does not hold the result', async () => {
    const t = performance.now();
    const r = await run('echo started; sleep 30 & echo $! > bg.pid');
    expect(performance.now() - t).toBeLessThan(5000);
    expect(r).toMatchObject({ isError: false, exitCode: 0 });
    expect(r.text).toContain('started');
    const pid = Number(await Bun.file(join(cwd, 'bg.pid')).text());
    process.kill(pid, 'SIGKILL');
  });

  test('exit codes come through', async () => {
    expect(await run('exit 3')).toMatchObject({ isError: true, exitCode: 3 });
    expect((await run('printf a; printf b >&2')).text).toBe('a\n[stderr]\nb\n[exit 0]');
    expect(existsSync(cwd)).toBe(true);
  });
});
