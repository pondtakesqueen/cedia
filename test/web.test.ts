import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hostAllowed, htmlText, PAGE_CHARS, privateAddress, webFetchTool } from '../src/core/tools/web.ts';

const ctx = (signal = new AbortController().signal) => ({ cwd: '/', signal }) as never;
let server: ReturnType<typeof Bun.serve>;
let base = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/page')
        return new Response('<html><head><title>Docs &amp; more</title><style>x{}</style><script>alert(1)</script></head><body><nav>menu</nav><h2>Install</h2><p>Run <code>bun add x</code> &mdash; then <a href="/next">read on</a>.</p><ul><li>one</li><li>two</li></ul><pre><b>let</b> a = 1;</pre></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (path === '/long') return new Response('x'.repeat(PAGE_CHARS + 10), { headers: { 'content-type': 'text/plain' } });
      if (path === '/png') return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
      if (path === '/away') return Response.redirect('http://169.254.169.254/latest/meta-data/', 302);
      if (path === '/hop') return Response.redirect(`${base}/page`, 301);
      if (path === '/missing') return new Response('not here', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response('?', { status: 500 });
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

describe('web_fetch', () => {
  // The test server is local, so the user names it, as they would their own docs server.
  const named = webFetchTool({ anyHost: false, allowedDomains: ['localhost'] });

  test('a page as readable text: title, headings, code, links and lists kept; scripts, styles and menus gone', async () => {
    const r = await named.run({ url: `${base}/page` }, ctx());
    expect(r.isError).toBe(false);
    expect(r.text).toContain('HTTP 200');
    expect(r.text).toContain('# Docs & more\n\n## Install\n\nRun `bun add x` — then [read on](/next).');
    expect(r.text).toContain('- one\n- two');
    expect(r.text).toContain('```\nlet a = 1;\n```');
    expect(r.text).not.toContain('alert');
    expect(r.text).not.toContain('menu');
  });

  test('a long page comes in parts; a redirect is followed; a non-text type and an HTTP error say so', async () => {
    const first = await named.run({ url: `${base}/long` }, ctx());
    expect(first.text).toContain(`[10 more characters: call again with offset ${PAGE_CHARS}]`);
    const rest = await named.run({ url: `${base}/long`, offset: PAGE_CHARS }, ctx());
    expect(rest.text.endsWith('xxxxxxxxxx')).toBe(true);
    expect((await named.run({ url: `${base}/hop` }, ctx())).text).toContain(`${base}/page (from ${base}/hop): HTTP 200`);
    expect(await named.run({ url: `${base}/png` }, ctx())).toEqual({ text: `${base}/png is image/png, not text, so it is not shown (HTTP 200)`, isError: false });
    expect((await named.run({ url: `${base}/missing` }, ctx())).isError).toBe(true);
  });

  test('only the hosts the session may reach; never a private address unless named; every redirect hop checked', async () => {
    const sandboxed = webFetchTool({ anyHost: false, allowedDomains: ['registry.npmjs.org'] });
    expect((await sandboxed.run({ url: 'https://example.com/' }, ctx())).text).toContain('example.com is not among the hosts this session may reach');
    const open = webFetchTool({ anyHost: true, allowedDomains: [] });
    expect((await open.run({ url: `${base}/page` }, ctx())).text).toContain('localhost is a private or local address');
    expect((await open.run({ url: 'http://[::1]:9/' }, ctx())).text).toContain('is a private or local address');
    expect((await named.run({ url: `${base}/away` }, ctx())).text).toContain('169.254.169.254 is not among the hosts');
    expect((await named.run({ url: 'file:///etc/passwd' }, ctx())).text).toBe('only http and https URLs: file:');
    expect((await named.run({ url: `http://user:pw@localhost:${server.port}/page` }, ctx())).text).toBe('a URL with credentials in it is not fetched');
  });

  test('helpers', () => {
    expect(hostAllowed('docs.npmjs.org', { anyHost: false, allowedDomains: ['npmjs.org'] })).toBe(true);
    expect(hostAllowed('evilnpmjs.org', { anyHost: false, allowedDomains: ['npmjs.org'] })).toBe(false);
    expect(hostAllowed('a.example.com', { anyHost: false, allowedDomains: ['*.example.com'] })).toBe(true);
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) expect(privateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(privateAddress(ip)).toBe(false);
    expect(htmlText('<p>a&#x41;&#66;&nbsp;b</p>')).toBe('aAB b');
  });
});
