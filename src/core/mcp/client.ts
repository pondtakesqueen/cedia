import type { Subprocess } from 'bun';
import type { JsonObject } from '../types.ts';

// A minimal Model Context Protocol client: the handshake, tools/list and tools/call, over a local process (stdio,
// one JSON-RPC message a line) or a URL (streamable HTTP: a POST a message, answered with JSON or an event
// stream). Nothing else of the protocol is used: a server's own requests get "method not found", except ping.

export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; readOnly?: boolean; timeoutSec?: number }
  | { url: string; headers?: Record<string, string>; readOnly?: boolean; timeoutSec?: number };

export type McpTool = { name: string; description?: string; inputSchema?: JsonObject };
export type McpContent = { type: string; text?: string; mimeType?: string; data?: string; resource?: { uri?: string; text?: string } };
export type McpCallResult = { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };

export const PROTOCOL_VERSION = '2025-06-18';
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
// What of a server's stderr is kept, to say why it failed.
const MAX_STDERR = 2_000;
// The longest message a server may send; past it the server is closed rather than read into memory forever.
const MAX_MESSAGE = 16 * 1024 * 1024;
// The variables a local server inherits from cedia; the rest (cedia's own API keys among them) stay out unless
// the server's config names them.
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'SYSTEMROOT', 'APPDATA', 'USERPROFILE'];

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

interface Transport {
  send(msg: Message, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  onMessage: (msg: Message) => void;
  onClose: (why: string) => void;
}

class StdioTransport implements Transport {
  onMessage: (msg: Message) => void = () => {};
  onClose: (why: string) => void = () => {};
  private proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  stderr = '';

  constructor(cfg: Extract<McpServerConfig, { command: string }>) {
    const env: Record<string, string> = {};
    for (const k of PASSED_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    const proc = Bun.spawn([cfg.command, ...(cfg.args ?? [])], { ...(cfg.cwd ? { cwd: cfg.cwd } : {}), env: { ...env, ...cfg.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    this.proc = proc;
    void this.read();
    void (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) this.stderr = (this.stderr + dec.decode(chunk, { stream: true })).slice(-MAX_STDERR);
    })().catch(() => {});
    void proc.exited.then((code) => this.onClose(`the server exited (${code})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
  }

  private async read() {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of this.proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            this.onMessage(JSON.parse(line) as Message);
          } catch {
            // A line that is not JSON (a server logging to stdout by mistake) is skipped.
          }
        }
        if (buf.length > MAX_MESSAGE) {
          this.onClose(`the server sent a message longer than ${MAX_MESSAGE} bytes`);
          this.proc.kill('SIGKILL');
          return;
        }
      }
    } catch {
      // The process went away; exited reports it.
    }
  }

  async send(msg: Message) {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    await this.proc.stdin.flush();
  }

  async close() {
    try {
      this.proc.stdin.end();
    } catch {}
    this.proc.kill('SIGTERM');
    const t = setTimeout(() => this.proc.kill('SIGKILL'), 2_000);
    await this.proc.exited;
    clearTimeout(t);
  }
}

class HttpTransport implements Transport {
  onMessage: (msg: Message) => void = () => {};
  onClose: (why: string) => void = () => {};
  private session: string | undefined;
  private version: string | undefined;

  constructor(private cfg: Extract<McpServerConfig, { url: string }>) {}

  setVersion(v: string) {
    this.version = v;
  }

  async send(msg: Message, signal?: AbortSignal) {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        ...this.cfg.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
        ...(this.version ? { 'mcp-protocol-version': this.version } : {}),
      },
      body: JSON.stringify(msg),
      ...(signal ? { signal } : {}),
    });
    const id = res.headers.get('mcp-session-id');
    if (id) this.session = id;
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the headers in the server config)' : ''}: ${(await res.text()).slice(0, 300)}`);
    if (res.status === 202 || !res.body) return;
    // A notification has no answer to wait for: a server that opens a stream for one is not read.
    if (msg.id === undefined) return void (await res.body.cancel().catch(() => {}));
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        if (buf.length > MAX_MESSAGE) throw new Error(`the server sent an event longer than ${MAX_MESSAGE} bytes`);
        let end: number;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const data = event
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) this.deliver(data);
        }
      }
    } else {
      const text = await res.text();
      if (text.trim()) this.deliver(text);
    }
  }

  private deliver(text: string) {
    try {
      const parsed = JSON.parse(text) as Message | Message[];
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) this.onMessage(m);
    } catch {
      // Not JSON: nothing to deliver.
    }
  }

  async close() {
    if (!this.session) return;
    await fetch(this.cfg.url, { method: 'DELETE', headers: { ...this.cfg.headers, 'mcp-session-id': this.session }, signal: AbortSignal.timeout(2_000) }).catch(() => {});
  }
}

export class McpClient {
  private transport: Transport;
  private next = 1;
  private pending = new Map<number, Pending>();
  private closed: string | undefined;

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
  ) {
    this.transport = 'command' in config ? new StdioTransport(config) : new HttpTransport(config);
    this.transport.onMessage = (m) => this.receive(m);
    this.transport.onClose = (why) => {
      this.closed ??= why;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
    };
  }

  private receive(m: Message) {
    if (m.method !== undefined) {
      // A request from the server: answer ping, decline the rest. Notifications need no answer.
      if (m.id !== undefined) void this.transport.send(m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `cedia does not support ${m.method}` } }).catch(() => {});
      return;
    }
    const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id as number);
    if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`));
    else p.resolve(m.result);
  }

  async request<T>(method: string, params: JsonObject, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new Error(this.closed);
    const id = this.next++;
    const done = new AbortController();
    const stop = AbortSignal.any([done.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    if (stop.aborted) throw new Error('stopped');
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        stop.addEventListener('abort', () => {
          // Answered already: the finally below aborts too, and there is nothing to cancel.
          if (!this.pending.delete(id)) return;
          const why = signal?.aborted ? 'stopped' : `no answer to ${method} in ${Math.round(timeoutMs / 1000)}s`;
          // Tell the server it may stop working on it.
          void this.notify('notifications/cancelled', { requestId: id, reason: why });
          reject(new Error(why));
        });
        this.transport.send({ jsonrpc: '2.0', id, method, params }, stop).then(
          () => {
            // Over HTTP the answer comes in the POST's own response: when that has ended without it, none will come.
            if (this.transport instanceof HttpTransport && this.pending.delete(id)) reject(new Error(`the server's response to ${method} ended without an answer`));
          },
          (e: Error) => {
            this.pending.delete(id);
            reject(e);
          },
        );
      });
    } finally {
      done.abort();
    }
  }

  async connect(): Promise<void> {
    const init = await this.request<{ protocolVersion?: string }>('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'cedia', version: '0.1.0' } }, CONNECT_TIMEOUT_MS);
    if (this.transport instanceof HttpTransport) this.transport.setVersion(init?.protocolVersion ?? PROTOCOL_VERSION);
    await this.notify('notifications/initialized', {});
  }

  // A notification: no answer, and no longer than a connect may take.
  private notify(method: string, params: JsonObject): Promise<void> {
    return this.transport.send({ jsonrpc: '2.0', method, params }, AbortSignal.timeout(CONNECT_TIMEOUT_MS)).catch(() => {});
  }

  async tools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    // A server that pages forever is cut off.
    for (let page = 0; page < 20; page++) {
      const r = await this.request<{ tools?: McpTool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS);
      out.push(...(r?.tools ?? []).filter((t) => t && typeof t.name === 'string'));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  call(tool: string, args: JsonObject, signal?: AbortSignal): Promise<McpCallResult> {
    const timeout = (this.config.timeoutSec ?? CALL_TIMEOUT_MS / 1000) * 1000;
    return this.request<McpCallResult>('tools/call', { name: tool, arguments: args }, timeout, signal);
  }

  async close(): Promise<void> {
    this.closed ??= 'closed';
    await this.transport.close().catch(() => {});
  }
}
