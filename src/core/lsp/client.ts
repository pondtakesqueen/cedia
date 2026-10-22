import type { Subprocess } from 'bun';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A minimal Language Server Protocol client: the handshake, opening a document, and the diagnostics the server
// publishes for it. Nothing else of the protocol is used; a server's own requests are answered with null (an empty
// configuration for each item asked, no edits applied), which servers take as "use your defaults".
// One JSON-RPC message per `Content-Length` frame over the server's stdio.
//
// A document is open only while its diagnostics are awaited, then closed: servers publish on every open but not on
// a change that leaves the diagnostics as they were (typescript-language-server), and a closed file is read from
// disk, so the server never holds a stale copy of a file changed since by bash or a formatter.

export type Diagnostic = { range: { start: { line: number; character: number } }; severity?: number; message: string; source?: string; code?: string | number };
type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

// The longest frame read; past it the server is closed rather than read into memory.
const MAX_MESSAGE = 32 * 1024 * 1024;
// How long the diagnostics for a change keep coming: servers may publish in steps (syntax, then semantics). An
// empty set is waited on longer, since a later step may still find errors.
const SETTLE_MS = 300;
const SETTLE_EMPTY_MS = 600;

// A file URI as a path, so a server that encodes `@` or `+` differently still names the same file.
const keyOf = (uri: string) => {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
};

export class LspClient {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private versions = new Map<string, number>();
  private published = new Map<string, { at: number; diagnostics: Diagnostic[] }>();
  private open = new Map<string, number>();
  private waiters = new Set<() => void>();
  private closed: string | undefined;
  stderr = '';
  // Called once when the server goes away on its own after the handshake.
  onExit?: (why: string) => void;

  // `argv` is the server's command line as it runs (in the sandbox when one is on).
  constructor(
    argv: string[],
    readonly root: string,
    env: Record<string, string>,
    // The process the server watches, exiting when it is gone; null when it cannot see cedia's (in the Linux
    // sandbox it has a process namespace of its own, and the sandbox stops it with cedia instead).
    private parentPid: number | null = process.pid,
  ) {
    // Its own process group, so the servers it starts (tsserver) stop with it.
    const proc = Bun.spawn(argv, { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true });
    this.proc = proc;
    void this.read();
    void (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) this.stderr = (this.stderr + dec.decode(chunk, { stream: true })).slice(-2_000);
    })().catch(() => {});
    void proc.exited.then((code) => {
      const why = `the server exited (${code})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}`;
      if (!this.closed && this.ready) this.onExit?.(why);
      this.fail(why);
    });
  }

  // The handshake is done.
  ready = false;

  // Stops the server and everything it started, at once.
  kill() {
    this.fail('killed');
    try {
      process.kill(-this.proc.pid, 'SIGKILL');
    } catch {
      this.proc.kill('SIGKILL');
    }
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
            this.kill();
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
        const p = m.params as { uri?: string; version?: number; diagnostics?: Diagnostic[] };
        const key = typeof p?.uri === 'string' ? keyOf(p.uri) : undefined;
        const open = key !== undefined ? this.open.get(key) : undefined;
        // Only for a document open now, and not for an older version of it.
        if (open !== undefined && Array.isArray(p.diagnostics) && !(typeof p.version === 'number' && p.version < open)) {
          this.published.set(key!, { at: Date.now(), diagnostics: p.diagnostics });
          for (const w of this.waiters) w();
        }
      }
      if (m.id !== undefined) this.send({ jsonrpc: '2.0', id: m.id, result: this.answer(m) });
      return;
    }
    const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id as number);
    if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`));
    else p.resolve(m.result);
  }

  private answer(m: Message): unknown {
    const items = (m.params as { items?: unknown[] } | undefined)?.items;
    if (m.method === 'workspace/configuration' && Array.isArray(items)) return items.map(() => null);
    if (m.method === 'workspace/workspaceFolders') return [{ uri: pathToFileURL(this.root).href, name: 'root' }];
    if (m.method === 'workspace/applyEdit') return { applied: false, failureReason: 'cedia applies no edits from a language server' };
    return null;
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
        processId: this.parentPid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'root' }],
        capabilities: { textDocument: { synchronization: {}, publishDiagnostics: { relatedInformation: false, versionSupport: true } }, workspace: { configuration: true, workspaceFolders: true } },
        clientInfo: { name: 'cedia' },
      },
      timeoutMs,
    );
    this.notify('initialized', {});
    this.ready = true;
  }

  // The diagnostics for `file`, which holds `text`: what the server publishes once the document is opened,
  // settled for a moment, or undefined when nothing comes in `timeoutMs` or the signal aborts.
  async diagnostics(file: string, text: string, languageId: string, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    if (this.closed || signal?.aborted) return undefined;
    const uri = pathToFileURL(file).href;
    const key = keyOf(uri);
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    this.published.delete(key);
    this.open.set(key, version);
    const wakeAll = () => {
      for (const w of this.waiters) w();
    };
    signal?.addEventListener('abort', wakeAll);
    try {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
      const end = Date.now() + timeoutMs;
      for (;;) {
        const got = this.published.get(key);
        const settle = got?.diagnostics.length ? SETTLE_MS : SETTLE_EMPTY_MS;
        // Settled: a publication since the open, and none in the last moment.
        if (got && Date.now() - got.at >= settle) return got.diagnostics;
        if (signal?.aborted) return undefined;
        if (this.closed || Date.now() >= end) return got?.diagnostics;
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(t);
            this.waiters.delete(wake);
            resolve();
          };
          const t = setTimeout(wake, Math.max(1, Math.min(got ? settle - (Date.now() - got.at) : Infinity, end - Date.now())));
          this.waiters.add(wake);
        });
      }
    } finally {
      signal?.removeEventListener('abort', wakeAll);
      this.open.delete(key);
      this.published.delete(key);
      this.notify('textDocument/didClose', { textDocument: { uri } });
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
    const t = setTimeout(() => this.kill(), 2_000);
    await this.proc.exited;
    clearTimeout(t);
    // What it started may outlive it.
    try {
      process.kill(-this.proc.pid, 'SIGKILL');
    } catch {}
  }
}
