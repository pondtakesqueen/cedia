import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

// `cedia serve` runs prompts in workspace mode, so it must listen on loopback only and turn away any request
// without its token: a web page posting to localhost, or a host on the network.
test('cedia serve listens on loopback and answers only a request with its token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cedia-serve-'));
  const proc = Bun.spawn([BIN, 'serve', '--port', '0'], { env: { ...process.env, CEDIA_HOME: home, CEDIA_SERVE_TOKEN: 'sekrit' }, stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = proc.stdout.getReader();
    let out = '';
    while (!/http:\/\/[^\s]+/.test(out)) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    const url = /http:\/\/[^\s]+/.exec(out)![0];
    expect(new URL(url).hostname).toBe('127.0.0.1');
    expect(out).not.toContain('sekrit');
    expect((await fetch(`${url}/sessions`)).status).toBe(401);
    expect((await fetch(`${url}/run`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ prompt: 'touch pwned' }) })).status).toBe(401);
    expect((await fetch(`${url}/sessions`, { headers: { authorization: 'Bearer wrong!' } })).status).toBe(401);
    expect((await fetch(`${url}/sessions`, { headers: { authorization: 'Bearer sekrit' } })).status).toBe(200);
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 20_000);
