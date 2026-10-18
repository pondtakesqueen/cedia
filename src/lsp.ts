import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
}

export interface LspResult {
  diagnostics: LspDiagnostic[];
  server: string;
}

export interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface LspHover {
  contents: string;
  server: string;
}

const SERVER_MAP: Record<string, string> = {
  ".rs": "rust-analyzer",
  ".ts": "typescript-language-server",
  ".tsx": "typescript-language-server",
  ".js": "typescript-language-server",
  ".jsx": "typescript-language-server",
  ".py": "pylsp",
  ".go": "gopls",
};

function findServer(ext: string): string | null {
  const server = SERVER_MAP[ext];
  if (!server) return null;
  try {
    const { execSync } = require("node:child_process");
    execSync(`which ${server}`, { stdio: "ignore" });
    return server;
  } catch {
    return null;
  }
}

function serverArgs(server: string): string[] {
  if (server === "typescript-language-server") return ["--stdio"];
  return [];
}

function sendRequest(child: ChildProcess, id: number, method: string, params: any): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
  child.stdin?.write(header + msg);
}

function sendNotification(child: ChildProcess, method: string, params: any): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
  child.stdin?.write(header + msg);
}

function makeRequest(child: ChildProcess, id: number, method: string, params: any, timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const handler = (data: Buffer) => {
      buffer += data.toString();
      while (true) {
        const headerMatch = buffer.match(/^Content-Length: (\d+)\r?\n\r?\n/);
        if (!headerMatch) break;
        const len = parseInt(headerMatch[1], 10);
        const headerLen = headerMatch[0].length;
        if (buffer.length < headerLen + len) break;
        const body = buffer.slice(headerLen, headerLen + len);
        buffer = buffer.slice(headerLen + len);
        try {
          const msg = JSON.parse(body);
          if (msg.id === id) {
            clearTimeout(timer);
            child.stdout?.removeListener("data", handler);
            resolve(msg.result ?? null);
          }
        } catch {
          // ignore
        }
      }
    };
    child.stdout?.on("data", handler);
    sendRequest(child, id, method, params);
  });
}

async function initialize(child: ChildProcess, cwd: string): Promise<boolean> {
  const result = await makeRequest(child, 1, "initialize", {
    processId: process.pid,
    rootUri: `file://${cwd}`,
    capabilities: {},
  }, 5000);
  if (result) {
    sendNotification(child, "initialized", {});
    return true;
  }
  return false;
}

export async function getDiagnostics(filePath: string, cwd: string): Promise<LspResult | null> {
  const ext = extname(filePath).toLowerCase();
  const server = findServer(ext);
  if (!server) return null;

  const args = serverArgs(server);
  const child = spawn(server, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const diagnostics: LspDiagnostic[] = [];
  let buffer = "";
  const timeout = 10000;

  return new Promise<LspResult | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ diagnostics, server });
    }, timeout);

    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      while (true) {
        const headerMatch = buffer.match(/^Content-Length: (\d+)\r?\n\r?\n/);
        if (!headerMatch) break;
        const len = parseInt(headerMatch[1], 10);
        const headerLen = headerMatch[0].length;
        if (buffer.length < headerLen + len) break;
        const body = buffer.slice(headerLen, headerLen + len);
        buffer = buffer.slice(headerLen + len);
        try {
          const msg = JSON.parse(body);
          if (msg.method === "textDocument/publishDiagnostics" && msg.params?.diagnostics) {
            for (const d of msg.params.diagnostics) diagnostics.push(d);
            clearTimeout(timer);
            setTimeout(() => { child.kill(); resolve({ diagnostics, server }); }, 500);
          }
        } catch {
          // ignore
        }
      }
    });

    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("exit", () => { clearTimeout(timer); resolve({ diagnostics, server }); });

    (async () => {
      const ok = await initialize(child, cwd);
      if (!ok) { child.kill(); resolve(null); return; }
      let content = "";
      try { content = readFileSync(filePath, "utf8"); } catch {}
      sendNotification(child, "textDocument/didOpen", {
        textDocument: { uri: `file://${filePath}`, languageId: ext.slice(1), version: 1, text: content },
      });
    })();
  });
}

export async function getHover(filePath: string, line: number, character: number, cwd: string): Promise<LspHover | null> {
  const ext = extname(filePath).toLowerCase();
  const server = findServer(ext);
  if (!server) return null;

  const child = spawn(server, serverArgs(server), { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const ok = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    const handler = (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('"result"')) {
        clearTimeout(timer);
        child.stdout?.removeListener("data", handler);
        resolve(true);
      }
    };
    child.stdout?.on("data", handler);
    sendRequest(child, 1, "initialize", { processId: process.pid, rootUri: `file://${cwd}`, capabilities: {} });
  });
  if (!ok) { child.kill(); return null; }

  sendNotification(child, "initialized", {});
  let content = "";
  try { content = readFileSync(filePath, "utf8"); } catch {}
  sendNotification(child, "textDocument/didOpen", {
    textDocument: { uri: `file://${filePath}`, languageId: ext.slice(1), version: 1, text: content },
  });

  const result = await makeRequest(child, 2, "textDocument/hover", {
    textDocument: { uri: `file://${filePath}` },
    position: { line: line - 1, character: character - 1 },
  }, 5000);

  child.kill();
  if (!result || !result.contents) return null;
  const contents = typeof result.contents === "string" ? result.contents : result.contents.value ?? JSON.stringify(result.contents);
  return { contents, server };
}

export async function getDefinition(filePath: string, line: number, character: number, cwd: string): Promise<LspLocation[] | null> {
  const ext = extname(filePath).toLowerCase();
  const server = findServer(ext);
  if (!server) return null;

  const child = spawn(server, serverArgs(server), { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const ok = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    const handler = (data: Buffer) => {
      if (data.toString().includes('"result"')) {
        clearTimeout(timer);
        child.stdout?.removeListener("data", handler);
        resolve(true);
      }
    };
    child.stdout?.on("data", handler);
    sendRequest(child, 1, "initialize", { processId: process.pid, rootUri: `file://${cwd}`, capabilities: {} });
  });
  if (!ok) { child.kill(); return null; }

  sendNotification(child, "initialized", {});
  let content = "";
  try { content = readFileSync(filePath, "utf8"); } catch {}
  sendNotification(child, "textDocument/didOpen", {
    textDocument: { uri: `file://${filePath}`, languageId: ext.slice(1), version: 1, text: content },
  });

  const result = await makeRequest(child, 2, "textDocument/definition", {
    textDocument: { uri: `file://${filePath}` },
    position: { line: line - 1, character: character - 1 },
  }, 5000);

  child.kill();
  if (!result) return null;
  const locations = Array.isArray(result) ? result : [result];
  return locations.map((l: any) => ({ uri: l.uri ?? l.targetUri, range: l.range ?? l.targetRange }));
}

export function formatDiagnostics(result: LspResult): string {
  if (result.diagnostics.length === 0) return `No diagnostics from ${result.server}.`;
  const lines = result.diagnostics.map((d) => {
    const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
    return `${result.server}: ${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}] ${d.message}`;
  });
  return lines.join("\n");
}