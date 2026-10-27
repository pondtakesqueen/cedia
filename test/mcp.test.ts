import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcp } from '../src/core/config.ts';
import { addMcp, checkMcp, listMcp, removeMcp } from '../src/core/mcp/manage.ts';
import { startMcp } from '../src/core/mcp/tools.ts';
import type { SessionEvent } from '../src/core/types.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';

const server = { command: process.execPath, args: [join(import.meta.dir, 'mcp', 'server.ts')] };
const ctx = (signal = new AbortController().signal) => ({ cwd: '/', signal }) as never;

describe('MCP', () => {
  test('a local server: its tools in name order across pages, schemas the providers take, calls and their errors', async () => {
    const m = await startMcp({ fake: { ...server, env: { FAKE_TOKEN: 'given' }, timeoutSec: 1 } });
    try {
      expect(m.notes).toEqual([]);
      expect(m.tools.map((t) => t.name)).toEqual(['mcp__fake__crash', 'mcp__fake__echo', 'mcp__fake__env', 'mcp__fake__fail', 'mcp__fake__picture', 'mcp__fake__slow']);
      const echo = m.tools.find((t) => t.name === 'mcp__fake__echo')!;
      expect(echo.schema).toEqual({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
      expect(echo.description).toBe('Echo the text back (MCP server fake)');
      expect(echo.effect).toBe('exec');
      const run = (name: string, input = {}, c = ctx()) => m.tools.find((t) => t.name === `mcp__fake__${name}`)!.run(input, c);
      expect(await run('echo', { text: 'hi' })).toEqual({ text: 'echo: hi', isError: false });
      expect(await run('fail')).toEqual({ text: 'it broke', isError: true });
      expect((await run('picture')).text).toBe('[image image/png, 3 bytes, not shown]\na picture');
      // cedia's own keys stay out of the server's environment; what the config names goes in.
      process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test';
      expect((await run('env')).text).toBe('FAKE_TOKEN=given ANTHROPIC_API_KEY=');
      expect(await run('slow', { ms: 5000 })).toEqual({ text: 'MCP server fake: no answer to tools/call in 1s', isError: true });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      expect((await run('slow', { ms: 5000 }, ctx(ac.signal))).text).toBe('MCP server fake: stopped');
      // Still answering after both.
      expect((await run('echo', { text: 'again' })).text).toBe('echo: again');
      const crashed = await run('crash');
      expect(crashed.isError).toBe(true);
      expect(crashed.text).toContain('the server exited (3): fatal: out of cheese');
      expect((await run('echo', { text: 'after' })).text).toContain('the server exited');
    } finally {
      await m.close();
    }
  });

  test('a URL server over streamable HTTP: JSON and event-stream answers, the session id kept', async () => {
    const seen: (string | null)[] = [];
    const http = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === 'DELETE') return new Response(null, { status: 204 });
        seen.push(req.headers.get('mcp-session-id'));
        if (req.headers.get('authorization') !== 'Bearer t0k') return new Response('no', { status: 401 });
        const m = (await req.json()) as { id?: number; method: string; params?: { arguments?: { text?: string } } };
        if (m.id === undefined) return new Response(null, { status: 202 });
        const json = (result: unknown, headers: Record<string, string> = {}) => Response.json({ jsonrpc: '2.0', id: m.id, result }, { headers });
        if (m.method === 'initialize') return json({ protocolVersion: '2025-06-18', capabilities: {} }, { 'mcp-session-id': 'sess-1' });
        if (m.method === 'tools/list') return json({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
        const body = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":${m.id},"result":{"content":[{"type":"text","text":"sse: ${m.params?.arguments?.text}"}]}}\n\n`;
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    process.env.CEDIA_TEST_MCP_TOKEN = 't0k';
    try {
      const home = mkdtempSync(join(tmpdir(), 'cedia-mcp-home-'));
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ mcpServers: { web: { url: `http://localhost:${http.port}/mcp`, headers: { authorization: 'Bearer ${CEDIA_TEST_MCP_TOKEN}' }, readOnly: true } } }));
      const saved = process.env.CEDIA_HOME;
      process.env.CEDIA_HOME = home;
      const servers = loadMcp();
      process.env.CEDIA_HOME = saved;
      const m = await startMcp(servers);
      expect(m.tools.map((t) => [t.name, t.effect])).toEqual([['mcp__web__echo', 'read']]);
      expect(await m.tools[0]!.run({ text: 'yo' }, ctx())).toEqual({ text: 'sse: yo', isError: false });
      await m.close();
      expect(seen).toEqual([null, 'sess-1', 'sess-1', 'sess-1']);
    } finally {
      http.stop(true);
    }
  });

  test('a URL server that holds a stream open for a notification, or ends one without the answer, does not hang the run', async () => {
    const http = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        if (req.method === 'DELETE') return new Response(null, { status: 204 });
        const m = (await req.json()) as { id?: number; method: string; params?: { name?: string } };
        // A notification answered with a stream that never ends.
        if (m.id === undefined) {
          let t: Timer;
          const body = new ReadableStream({
            start(c) {
              t = setInterval(() => c.enqueue(new TextEncoder().encode(': keepalive\n\n')), 100);
            },
            cancel() {
              clearInterval(t);
            },
          });
          return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        }
        const json = (result: unknown) => Response.json({ jsonrpc: '2.0', id: m.id, result });
        if (m.method === 'initialize') return json({ protocolVersion: '2025-06-18', capabilities: {} });
        if (m.method === 'tools/list')
          return json({ tools: [{ name: 'lost', inputSchema: { type: 'object', properties: 'x' } }, { name: 'big', inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'y'.repeat(20_000) } } } }] });
        // A stream that ends with only a progress notification in it.
        return new Response('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      const started = Date.now();
      const m = await startMcp({ odd: { url: `http://localhost:${http.port}/mcp`, timeoutSec: 30 } });
      expect(m.notes).toEqual([]);
      // Schemas a provider would refuse, or too big to send on every request, become an open object.
      expect(m.tools.map((t) => t.schema)).toEqual([
        { type: 'object', properties: {}, additionalProperties: true },
        { type: 'object', properties: {}, additionalProperties: true },
      ]);
      expect(await m.tools[0]!.run({}, ctx())).toEqual({ text: "MCP server odd: the server's response to tools/call ended without an answer", isError: true });
      expect(Date.now() - started).toBeLessThan(5_000);
      await m.close();
    } finally {
      http.stop(true);
    }
  });

  test('a server that does not start is left out with a note; the others still work', async () => {
    const m = await startMcp({ gone: { command: '/nonexistent/mcp-server' }, fake: server });
    try {
      expect(m.notes).toHaveLength(1);
      expect(m.notes[0]).toStartWith('cedia: MCP server gone did not start: ');
      expect(m.tools.every((t) => t.name.startsWith('mcp__fake__'))).toBe(true);
    } finally {
      await m.close();
    }
  });

  test('settings: a command or a URL, checked; ${VAR} read from the environment', () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-mcp-cfg-'));
    const load = (servers: unknown) => {
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ mcpServers: servers }));
      const saved = process.env.CEDIA_HOME;
      process.env.CEDIA_HOME = home;
      try {
        return loadMcp({ TOKEN: 'abc' });
      } finally {
        process.env.CEDIA_HOME = saved;
      }
    };
    expect(load({ a: { command: 'x', args: ['-y'], env: { K: 'pre-${TOKEN}-${MISSING}' } } })).toEqual({ a: { command: 'x', args: ['-y'], env: { K: 'pre-abc-' } } });
    expect(() => load({ a: { command: 'x', url: 'http://h' } })).toThrow('needs either a command or a url');
    expect(() => load({ a: { url: 'file:///etc/passwd' } })).toThrow('must be http(s)');
    expect(() => load({ a: { command: 'x', shell: true } })).toThrow('unknown key "shell"');
    expect(() => load({ 'a b': { command: 'x' } })).toThrow('a server name is');
    expect(() => load({ a: { command: 'x', env: { K: 1 } } })).toThrow('must map names to strings');
  });

  test('in a run: the writer calls a server tool in workspace mode; a read-only run is refused without an allow rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-mcp-run-'));
    const home = join(dir, '.home');
    mkdirSync(home);
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ mcpServers: { fake: server } }));
    const script = join(dir, '.script.json');
    writeFileSync(script, JSON.stringify([{ blocks: [{ type: 'tool_use', id: 'm1', name: 'mcp__fake__echo', input: { text: 'from the model' } }] }, { blocks: [{ type: 'text', text: 'done' }] }]));
    const run = (...flags: string[]) => {
      const p = Bun.spawnSync([join(import.meta.dir, '..', 'bin', 'cedia'), '-m', 'faux', '-p', 'hi', '--cwd', dir, '--sandbox', 'off', '--output-format', 'json', ...flags], { env: { ...process.env, CEDIA_FAUX_SCRIPT: script, CEDIA_HOME: home } });
      expect(p.exitCode).toBe(0);
      const sessions = join(home, 'sessions');
      const [project] = readdirSync(sessions);
      const id = (JSON.parse(p.stdout.toString()) as { sessionId: string }).sessionId;
      const events = SessionLog.load(join(sessions, project!, `${id}.jsonl`)).events;
      expect(lintSession(events)).toEqual([]);
      return events;
    };
    const resultOf = (events: ReturnType<typeof run>) => JSON.stringify(events.find((e) => e.kind === 'tool_result'));
    expect(resultOf(run('--permission', 'workspace'))).toContain('echo: from the model');
    expect(resultOf(run('--permission', 'read-only'))).toContain('read-only');
    expect(resultOf(run('--permission', 'read-only', '--allow', 'mcp__fake__echo'))).toContain('echo: from the model');
  });

  test('cedia mcp: add, list without secrets, check by starting it, and remove, leaving the other settings as they were', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-mcp-manage-'));
    const saved = process.env.CEDIA_HOME;
    process.env.CEDIA_HOME = home;
    try {
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ desktop: { theme: 'cedian Dark' }, todo: true }));
      addMcp('fake', { ...server, env: { FAKE_TOKEN: 'secret' }, readOnly: true });
      addMcp('web', { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } });
      expect(() => addMcp('bad', { url: 'ftp://x' })).toThrow('must be http(s)');
      expect(listMcp()).toEqual({
        servers: [
          { name: 'fake', command: server.command, args: server.args, env: ['FAKE_TOKEN'], readOnly: true },
          { name: 'web', url: 'https://example.com/mcp', headers: ['Authorization'] },
        ],
      });
      expect(JSON.stringify(listMcp())).not.toContain('secret');
      const check = await checkMcp('fake');
      expect(check.ok && check.tools.map((t) => t.name)).toEqual(['crash', 'echo', 'env', 'fail', 'picture', 'slow']);
      expect(check.ok && check.tools.find((t) => t.name === 'echo')).toEqual({ name: 'echo', description: 'Echo the text back' });
      expect(await checkMcp('nope')).toMatchObject({ ok: false, error: expect.stringContaining('no MCP server nope') });
      removeMcp('web');
      expect(() => removeMcp('web')).toThrow('no MCP server web');
      const written = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
      expect(written).toEqual({ desktop: { theme: 'cedian Dark' }, todo: true, mcpServers: { fake: { ...server, env: { FAKE_TOKEN: 'secret' }, readOnly: true } } });
      // An entry cedia would refuse is listed with why, so a client can show it and offer to remove it.
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ mcpServers: { odd: { command: 'x', shell: true } } }));
      expect(listMcp().servers).toEqual([{ name: 'odd', command: 'x', error: expect.stringContaining('unknown key "shell"') }]);
      expect(await checkMcp('odd')).toMatchObject({ ok: false });
    } finally {
      process.env.CEDIA_HOME = saved;
    }
  });
});

describe('MCP reconnect', () => {
  test('a remote server that answers late still makes the initial tool list (connect retried)', async () => {
    let initializes = 0;
    const sleeps: number[] = [];
    const http = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === 'DELETE') return new Response(null, { status: 204 });
        const m = (await req.json()) as { id?: number; method: string };
        const json = (result: unknown) => Response.json({ jsonrpc: '2.0', id: m.id, result });
        if (m.method === 'initialize') {
          initializes++;
          if (initializes < 3) return new Response('starting', { status: 503 });
          return json({ protocolVersion: '2025-06-18', capabilities: {} });
        }
        if (m.method === 'tools/list') return json({ tools: [{ name: 'late', inputSchema: { type: 'object' } }] });
        return new Response(null, { status: 202 });
      },
    });
    try {
      const m = await startMcp({ late: { url: `http://localhost:${http.port}/mcp`, timeoutSec: 5 } }, async (ms) => void sleeps.push(ms));
      try {
        expect(m.notes).toEqual([]);
        expect(m.tools.map((t) => t.name)).toEqual(['mcp__late__late']);
        expect(initializes).toBe(3);
        expect(sleeps).toEqual([1000, 2000]);
      } finally {
        await m.close();
      }
    } finally {
      http.stop(true);
    }
  });

  test('a local server that cannot start fails fast, without retries', async () => {
    const sleeps: number[] = [];
    const m = await startMcp({ gone: { command: '/nonexistent/mcp-server' } }, async (ms) => void sleeps.push(ms));
    try {
      expect(m.notes).toHaveLength(1);
      expect(sleeps).toEqual([]);
    } finally {
      await m.close();
    }
  });

  test('past the definition budget, tools go out stripped with full text in the search index', async () => {
    const { budgetMcpTools, MCP_DEF_BUDGET } = await import('../src/core/mcp/tools.ts');
    const big = (i: number) => ({ name: `mcp__s__tool${i}`, description: `${`tool ${i} does things with binaries and symbols. `}x`.repeat(40), schema: { type: 'object', properties: { q: { type: 'string', description: 'a query'.repeat(20) } } }, effect: 'exec' as const, replay: 'unsafe' as const, run: async () => ({ text: 'ok', isError: false }) });
    const specs = Array.from({ length: 30 }, (_, i) => big(i));
    const { tools, index } = budgetMcpTools(specs);
    expect(tools.map((t) => t.name)).toEqual(specs.map((t) => t.name));
    const direct = tools.filter((t) => !index.some((d) => d.name === t.name));
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.length).toBeLessThan(specs.length);
    for (const t of direct) expect(t.description).toContain('tool');
    const sent = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }))).length;
    const full = JSON.stringify(specs.map((t) => ({ name: t.name, description: t.description, schema: t.schema }))).length;
    // Stripped names and one-liners still ride along, but the full weight does not.
    expect(sent).toBeLessThan(full);
    for (const d of index) {
      const out = tools.find((t) => t.name === d.name)!;
      expect(out.description).toContain(`search ToolSearch for ${d.name}`);
      expect(out.description.length).toBeLessThanOrEqual(160 + 60);
      expect(out.schema).toEqual({ type: 'object', additionalProperties: true });
      expect(d.description.length).toBeGreaterThan(out.description.length);
    }
    // Deterministic: the same tools always split the same way.
    expect(budgetMcpTools(specs).index.map((d) => d.name)).toEqual(index.map((d) => d.name));
  });

  test('under the budget everything stays full, exactly as before', async () => {
    const { budgetMcpTools } = await import('../src/core/mcp/tools.ts');
    const m = await startMcp({ fake: server });
    try {
      const { tools, index } = budgetMcpTools(m.tools);
      expect(index).toEqual([]);
      expect(tools).toEqual(m.tools);
    } finally {
      await m.close();
    }
  });

  test('a stripped tool is found through ToolSearch and still runs by name', async () => {
    const { budgetMcpTools } = await import('../src/core/mcp/tools.ts');
    const { clearDeferred, registerDeferred, toolSearchTool } = await import('../src/core/tools/tool-search.ts');
    const { fauxProvider, text, toolUse } = await import('../src/core/providers/faux.ts');
    const { FAUX_MODEL } = await import('../src/core/providers/catalog.ts');
    const { runPrompt } = await import('../src/core/loop/run.ts');
    const { SessionLog } = await import('../src/core/session/log.ts');
    const m = await startMcp({ fake: server });
    try {
      // Force the deferral: one near-budget sibling eats it first (itself just fits, the next does not).
      const filler = { name: 'mcp__s__big', description: 'x'.repeat(31_800), schema: { type: 'object' }, effect: 'exec' as const, replay: 'unsafe' as const, run: async () => ({ text: 'big', isError: false }) };
      const { tools, index } = budgetMcpTools([filler, ...m.tools]);
      expect(index.map((d) => d.name)).toContain('mcp__fake__echo');
      clearDeferred();
      for (const d of index) registerDeferred(d);
      const stripped = tools.filter((t) => index.some((d) => d.name === t.name));
      const log = SessionLog.create();
      const cwd = mkdtempSync(join(tmpdir(), 'cedia-mcp-defer-'));
      const res = await runPrompt(
        {
          log,
          provider: fauxProvider([
            { blocks: [toolUse('q1', 'ToolSearch', { query: 'echo' })] },
            { blocks: [toolUse('c1', 'mcp__fake__echo', { text: 'hi' })] },
            { blocks: [text('done')] },
          ]),
          model: FAUX_MODEL,
          tools: [toolSearchTool, ...stripped],
          system: 'sys',
          cwd,
          permission: { mode: 'workspace', allow: [], deny: [] },
        },
        'say it back',
      );
      expect(res.subtype).toBe('success');
      const found = log.events.find((e): e is Extract<SessionEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.callId === 'q1')!;
      expect(found.output.text).toContain('mcp__fake__echo');
      expect(found.output.text).toContain('Echo the text back');
      expect(log.events.find((e): e is Extract<SessionEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.callId === 'c1')).toMatchObject({ status: 'completed', output: { text: 'echo: hi' } });
      const { lintSession } = await import('../src/core/session/lint.ts');
      expect(lintSession(log.events)).toEqual([]);
    } finally {
      clearDeferred();
      await m.close();
    }
  });
});
