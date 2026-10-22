import type { Subprocess } from 'bun';
import { pathToFileURL } from 'node:url';

// A minimal Language Server Protocol client: the handshake, opening and changing a document, and the diagnostics
// the server publishes for it. Nothing else of the protocol is used; a server's own requests are answered with
// null (an empty configuration for each item asked), which servers take as "use your defaults".
// One JSON-RPC message per `Content-Length` frame over the server's stdio.

export type Diagnostic = { range: { start: { line: number; character: number } }; severity?: number; message: string; source?: string; code?: string | number };
type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

// The longest frame read; past it the server is closed rather than read into memory.
const MAX_MESSAGE = 32 * 1024 * 1024;
// How long the diagnostics for a change keep coming: servers publish in steps (syntax, then semantics).
const SETTLE_MS = 300;

export class LspClient {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private versions = new Map<string, number>();
  private published = new Map<string, { at: number; diagnostics: Diagnostic[] }>();
  private waiters = new Set<() => void>();
  private closed: string | undefined;
  stderr = '';

  // `argv` is the server's command line as it runs (in the sandbox when one is on).
  constructor(
    argv: string[],
    readonly root: string,
    env: Record<string, string>,
  ) {
    const proc = Bun.spawn(argv, { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    this.proc = proc;
    void this.read();
    void (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) this.stderr = (this.stderr + dec.decode(chunk, { stream: true })).slice(-2_000);
    })().catch(() => {});
    void proc.exited.then((code) => this.fail(`the server exited (${code})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}`));
  }

  private fail(why: string) {
    this.closed ??= why;
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
    for (const w of this.waiters) w();
  }

  private async read() {
    let buf = Buffer.alloc(0);
    try {
      for await (const chunk of this.proc.stdout) {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const head = buf.indexOf('\r\n\r\n');
          if (head < 0) break;
          const length = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, head).toString('ascii'))?.[1]);
          if (!(length >= 0) || length > MAX_MESSAGE) {
            this.fail('the server sent a frame cedia cannot read');
            this.proc.kill('SIGKILL');
            return;
          }
          if (buf.length < head + 4 + length) break;
          const body = buf.subarray(head + 4, head + 4 + length).toString('utf8');
          buf = buf.subarray(head + 4 + length);
          try {
            this.receive(JSON.parse(body) as Message);
          } catch {
            // Not JSON: skipped.
          }
        }
      }
    } catch {
      // The process went away; exited reports it.
    }
  }

  private send(msg: Message) {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    try {
      this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      this.proc.stdin.write(body);
      void this.proc.stdin.flush();
    } catch (e) {
      this.fail(`cannot write to the server: ${(e as Error).message}`);
    }
  }

  private receive(m: Message) {
    if (m.method !== undefined) {
      if (m.method === 'textDocument/publishDiagnostics') {
        const p = m.params as { uri?: string; diagnostics?: Diagnostic[] };
        if (typeof p?.uri === 'string' && Array.isArray(p.diagnostics)) {
          this.published.set(p.uri, { at: Date.now(), diagnostics: p.diagnostics });
          for (const w of this.waiters) w();
        }
      }
      if (m.id !== undefined) {
        const items = (m.params as { items?: unknown[] } | undefined)?.items;
        this.send({ jsonrpc: '2.0', id: m.id, result: m.method === 'workspace/configuration' && Array.isArray(items) ? items.map(() => null) : null });
      }
      return;
    }
    const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id as number);
    if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`));
    else p.resolve(m.result);
  }

  private request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v as T)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async start(timeoutMs: number): Promise<void> {
    const rootUri = pathToFileURL(this.root).href;
    await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'root' }],
        capabilities: { textDocument: { synchronization: { didSave: true }, publishDiagnostics: { relatedInformation: false } }, workspace: { configuration: true, workspaceFolders: true } },
        clientInfo: { name: 'cedia' },
      },
      timeoutMs,
    );
    this.notify('initialized', {});
  }

  // The diagnostics for `file` once it holds `text`: what the server publishes after it is told, settled for a
  // moment, or undefined when nothing comes in `timeoutMs`.
  async diagnostics(file: string, text: string, languageId: string, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    if (this.closed) return undefined;
    const uri = pathToFileURL(file).href;
    const sent = Date.now();
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    this.notify('textDocument/didSave', { textDocument: { uri }, text });
    const end = sent + timeoutMs;
    for (;;) {
      const got = this.published.get(uri);
      const fresh = got && got.at >= sent;
      // Settled: a publication since the change, and none in the last moment.
      if (fresh && Date.now() - got.at >= SETTLE_MS) return got.diagnostics;
      if (this.closed || signal?.aborted || Date.now() >= end) return fresh ? got.diagnostics : undefined;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(t);
          this.waiters.delete(wake);
          resolve();
        };
        const t = setTimeout(wake, Math.max(1, Math.min(fresh ? SETTLE_MS : end - Date.now(), end - Date.now())));
        this.waiters.add(wake);
      });
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      await this.request('shutdown', null, 2_000).catch(() => {});
      this.notify('exit', null);
    }
    this.closed ??= 'closed';
    try {
      this.proc.stdin.end();
    } catch {}
    const t = setTimeout(() => this.proc.kill('SIGKILL'), 2_000);
    await this.proc.exited;
    clearTimeout(t);
  }
}
