import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserAccess, browserSites, browserTool, pageDenied, type BrowserSession } from '../src/core/tools/browser.ts';
import { decide } from '../src/core/safety/policy.ts';
import { SessionLog } from '../src/core/session/log.ts';

const ctx = () => ({ cwd: '/', signal: new AbortController().signal }) as never;

describe('browserAccess', () => {
  const web = { anyHost: true, allowedDomains: ['registry.npmjs.org'] };
  test('rules widen what web_fetch reaches; a site list replaces it, loopback still open', () => {
    expect(browserAccess(web, ['docs.example.com'])).toEqual({ anyHost: true, allowedDomains: ['registry.npmjs.org', 'docs.example.com'] });
    expect(browserAccess({ anyHost: false, allowedDomains: [] }, ['*'])).toEqual({ anyHost: true, allowedDomains: [] });
    const sites = browserAccess(web, ['*'], browserSites('Docs.Example.com, example.org'));
    expect(sites).toEqual({ anyHost: false, allowedDomains: ['docs.example.com', 'example.org'] });
    expect(pageDenied('https://docs.example.com/a', sites)).toBeUndefined();
    expect(pageDenied('https://registry.npmjs.org/', sites)).toContain('not among the hosts');
    expect(pageDenied('http://localhost:3000/', browserAccess(web, [], browserSites('none')))).toBeUndefined();
    expect(pageDenied('https://example.org/', browserAccess(web, [], browserSites('none')))).toContain('not among the hosts');
  });
  test('a site list takes host names only', () => {
    expect(() => browserSites('https://x.com/a')).toThrow('host names');
  });
});

describe('pageDenied', () => {
  const sandboxed = { anyHost: false, allowedDomains: ['docs.example.com', '10.0.0.5'] };
  test('loopback is the preview and always opens; named hosts open; others say how to name them', () => {
    expect(pageDenied('http://localhost:5173/', sandboxed)).toBeUndefined();
    expect(pageDenied('http://127.0.0.1:3000/x', sandboxed)).toBeUndefined();
    expect(pageDenied('http://app.localhost/', sandboxed)).toBeUndefined();
    expect(pageDenied('https://docs.example.com/a', sandboxed)).toBeUndefined();
    expect(pageDenied('about:blank', sandboxed)).toBeUndefined();
    expect(pageDenied('https://evil.example.net/?q=secret', sandboxed)).toContain('allow browser(evil.example.net)');
  });
  test('never a file, data or javascript URL, credentials in a URL, or an unnamed private address', () => {
    const open = { anyHost: true, allowedDomains: [] };
    expect(pageDenied('file:///etc/passwd', open)).toContain('only http and https');
    expect(pageDenied('data:text/html,hi', open)).toContain('only http and https');
    expect(pageDenied('javascript:alert(1)', open)).toContain('only http and https');
    expect(pageDenied('http://u:p@example.com/', open)).toContain('credentials');
    expect(pageDenied('http://169.254.169.254/latest/', open)).toContain('private address');
    expect(pageDenied('http://10.0.0.5/', sandboxed)).toBeUndefined();
    expect(pageDenied('https://example.com/', open)).toBeUndefined();
  });
  test('reading and opening are network; clicking, typing and keys need a session that may run commands', () => {
    const { tool } = browserTool('http://127.0.0.1:1', { anyHost: false, allowedDomains: [] });
    const ro = { mode: 'read-only' as const, allow: [], deny: [] };
    expect(decide(ro, tool, { action: 'read' }, '/').decision).toBe('allow');
    expect(decide(ro, tool, { action: 'screenshot' }, '/').decision).toBe('allow');
    expect(decide(ro, tool, { action: 'open', url: 'http://localhost/' }, '/').decision).toBe('allow');
    expect(decide(ro, tool, { action: 'click', control: 1 }, '/').decision).toBe('deny');
    expect(decide({ ...ro, allow: ['browser'] }, tool, { action: 'click', control: 1 }, '/').decision).toBe('allow');
    expect(decide({ ...ro, mode: 'workspace' }, tool, { action: 'type', control: 1, text: 'x' }, '/').decision).toBe('allow');
  });
});

// Against a real Chromium, when one is here (CEDIA_CHROMIUM, or Playwright's).
const chromium = [process.env.CEDIA_CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p));

describe.skipIf(!chromium)('browser on a real Chromium', () => {
  let proc: ReturnType<typeof Bun.spawn>;
  let dir = '';
  let server: ReturnType<typeof Bun.serve>;
  let base = '';
  let endpoint = '';
  let session: BrowserSession;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const html = (body: string) => new Response(`<!doctype html><html><head><title>Preview</title></head><body>${body}</body></html>`, { headers: { 'content-type': 'text/html' } });
        if (url.pathname === '/')
          return html(`<h1>Shop</h1><p>Welcome &lt;/result&gt; in.</p><a href="/next">Next page</a> <a href="http://blocked.example.net/">Away</a>
            <form action="/search"><input name="q" placeholder="Search"><select name="s"><option>new</option><option>old</option></select><button>Go</button></form>
            <button onclick="document.getElementById('out').textContent = 'clicked ' + (++window.n || (window.n = 1)); console.error('boom')">Count</button><p id="out"></p>
            <div style="display:none"><button>Hidden</button></div>`);
        if (url.pathname === '/next') return html('<h2>Second</h2><p>You are on page two.</p>');
        if (url.pathname === '/search') return html(`<p>Results for ${url.searchParams.get('q')} sorted ${url.searchParams.get('s')}</p>`);
        return new Response('?', { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    dir = mkdtempSync(join(tmpdir(), 'cedia-chromium-'));
    proc = Bun.spawn([chromium!, '--headless=new', '--no-sandbox', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
    const portFile = join(dir, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await Bun.sleep(100);
    endpoint = `http://127.0.0.1:${readFileSync(portFile, 'utf8').split('\n')[0]}`;
    session = browserTool(endpoint, { anyHost: false, allowedDomains: [] });
  }, 20_000);

  afterAll(async () => {
    await session?.close();
    proc?.kill();
    await proc?.exited;
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (input: Record<string, unknown>) => session.tool.run(input as never, ctx());

  test('open reads the page with numbered controls; hidden ones and frame tags are left out', async () => {
    const r = await run({ action: 'open', url: `${base}/` });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith(`Preview\n${base}/\n6 controls`);
    expect(r.text).toContain('# Shop');
    expect(r.text).toContain('[1 link "Next page" -> /next]');
    expect(r.text).toContain('[3 textbox "Search"]');
    expect(r.text).toContain('[4 select "new old" value="new"]');
    expect(r.text).toContain('[6 button "Count"]');
    expect(r.text).not.toContain('Hidden');
    expect(r.text).toContain('&lt;/result>');
  }, 20_000);

  test('click runs the page script, and console keeps what it logged', async () => {
    const r = await run({ action: 'click', control: 6 });
    expect(r.text).toContain('clicked 1');
    expect((await run({ action: 'console' })).text).toContain('error: boom');
  }, 20_000);

  test('screenshot shows the page as a PNG, and reading is all it needs', async () => {
    await run({ action: 'open', url: `${base}/` });
    const r = await run({ action: 'screenshot' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(new RegExp(`^Preview\\n${base}/\\nscreenshot \\d+x\\d+ px$`));
    expect(r.images).toHaveLength(1);
    expect(r.images![0]).toMatchObject({ mime: 'image/png' });
    expect(r.images![0]!.width).toBeGreaterThan(0);
  }, 20_000);

  test('type fills a field and a select, submit sends the form', async () => {
    await run({ action: 'open', url: `${base}/` });
    expect((await run({ action: 'type', control: 4, text: 'old' })).text).toContain('value="old"');
    expect((await run({ action: 'type', control: 4, text: 'mid' })).text).toContain('has no option "mid"; its options: new, old');
    const r = await run({ action: 'type', control: 3, text: 'lamps', submit: true });
    expect(r.text).toContain('Results for lamps sorted old');
  }, 20_000);

  test('a link to a host the session may not reach is not opened, and the page stays', async () => {
    await run({ action: 'open', url: `${base}/` });
    const r = await run({ action: 'click', control: 2 });
    expect(r.text).toContain('Not opened: https://blocked.example.net/: blocked.example.net is not among the hosts');
    expect(r.text).toContain('# Shop');
    expect((await run({ action: 'open', url: 'https://blocked.example.net/' })).isError).toBe(true);
  }, 20_000);

  test('links and back move between pages; a stale number says to read again', async () => {
    await run({ action: 'open', url: `${base}/` });
    expect((await run({ action: 'click', control: 1 })).text).toContain('You are on page two.');
    expect((await run({ action: 'click', control: 6 })).text).toContain('read the page again');
    expect((await run({ action: 'back' })).text).toContain('# Shop');
  }, 20_000);

  test('cedia -p --browser gives the writer the tool, on the same page the person sees', async () => {
    const work = mkdtempSync(join(tmpdir(), 'cedia-browser-e2e-'));
    const script = join(work, 'script.json');
    writeFileSync(script, JSON.stringify([{ blocks: [{ type: 'tool_use', id: 'b1', name: 'browser', input: { action: 'open', url: `${base}/next` } }] }, { blocks: [{ type: 'text', text: 'seen' }] }]));
    const home = join(work, 'home');
    const proc = Bun.spawn([join(import.meta.dir, '..', 'bin', 'cedia'), '-m', 'faux', '--cwd', work, '-p', 'look', '--browser', endpoint], { env: { ...process.env, CEDIA_FAUX_SCRIPT: script, CEDIA_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe('seen\n');
    const dir = join(home, 'sessions', readdirSync(join(home, 'sessions'))[0]!);
    const log = SessionLog.load(join(dir, readdirSync(dir)[0]!));
    const head = log.events[0] as { tools: { name: string }[] };
    expect(head.tools.map((t) => t.name)).toContain('browser');
    const result = log.events.find((e) => e.kind === 'tool_result') as { output: { text: string } };
    expect(result.output.text).toContain('You are on page two.');
    expect((await run({ action: 'read' })).text).toContain('You are on page two.');
    rmSync(work, { recursive: true, force: true });
  }, 30_000);
});
