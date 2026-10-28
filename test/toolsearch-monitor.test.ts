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
});
