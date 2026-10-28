import { describe, expect, test } from 'bun:test';

describe('toolsearch', () => {
  test('keyword/select/max_results', async () => {
    const m = await import('../src/core/tools/tool-search.ts');
    m.clearDeferred();
    m.registerDeferred({ name: 'mcp__x__foo', description: 'foo bar baz' });
    m.registerDeferred({ name: 'mcp__x__bar', description: 'bar only' });
    const ctx = { cwd: '/tmp', signal: new AbortController().signal } as any;
    let r = await m.toolSearchTool.run({ query: 'foo', max_results: 1 }, ctx);
    const arr = JSON.parse(r.text);
    expect(arr.length).toBe(1);
    expect(arr[0].name).toBe('mcp__x__foo');
    r = await m.toolSearchTool.run({ query: 'select:mcp__x__bar' }, ctx);
    expect(JSON.parse(r.text)[0].name).toBe('mcp__x__bar');
    r = await m.toolSearchTool.run({ query: 'zzz' }, ctx);
    expect(r.text).toBe('no tools found');
  });
});

describe('monitor', () => {
  test('captures and filters', async () => {
    const m = await import('../src/core/tools/monitor.ts');
    const ctx = { cwd: '/tmp', signal: new AbortController().signal } as any;
    const r = await m.monitorTool.run({ command: 'printf "a\\nb\\nc\\n"', timeout_ms: 2000 }, ctx);
    expect(r.text).toContain('a');
    const r2 = await m.monitorTool.run({ command: 'printf "a\\nb\\nc\\n"', timeout_ms: 2000, filter: 'b' }, ctx);
    expect(r2.text).toBe('b');
  }, 15_000);

  test('runs without cedia credentials, in the working directory, and stops on abort', async () => {
    const m = await import('../src/core/tools/monitor.ts');
    const { mkdtempSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cedia-monitor-')));
    process.env.CEDIA_MONITOR_TEST_TOKEN = 'leak';
    try {
      const r = await m.monitorTool.run({ command: 'echo "${CEDIA_MONITOR_TEST_TOKEN:-none}"; pwd', timeout_ms: 5000 }, { cwd: dir, signal: new AbortController().signal } as any);
      expect(r.text).toBe(`none\n${dir}`);
    } finally {
      delete process.env.CEDIA_MONITOR_TEST_TOKEN;
    }
    const failed = await m.monitorTool.run({ command: 'echo x; exit 3', timeout_ms: 5000 }, { cwd: dir, signal: new AbortController().signal } as any);
    expect(failed).toMatchObject({ text: 'x\n[exit 3]', isError: true });
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 100);
    const aborted = await m.monitorTool.run({ command: 'echo up; sleep 30', timeout_ms: 60000 }, { cwd: dir, signal: ac.signal } as any);
    expect(aborted).toMatchObject({ text: 'up\n[aborted]', isError: true });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15_000);
});
