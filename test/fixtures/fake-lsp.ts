// A language server for tests: every line holding ERR is an error, every line holding WARN a warning. It asks the
// client for its configuration once, as real servers do. Flags:
//   --probe <path>     tries to write there at start (the sandbox test checks it cannot)
//   --pidfile <path>   writes its pid there
//   --late <ms>        publishes the errors that long after the empty first step (a slow semantic pass)
//   --silent           never publishes
//   --init-delay <ms>  answers initialize that late
//   --encode           names files with `@` encoded, as some servers do
import { writeFileSync } from 'node:fs';

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? '') : undefined;
};
const probe = flag('--probe');
if (probe !== undefined) {
  try {
    writeFileSync(probe, 'escaped\n');
  } catch {}
}
const pidfile = flag('--pidfile');
if (pidfile !== undefined) writeFileSync(pidfile, String(process.pid));
const late = Number(flag('--late') ?? 50);
const initDelay = Number(flag('--init-delay') ?? 0);
const silent = process.argv.includes('--silent');
const encode = process.argv.includes('--encode');

const send = (msg: object) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};

const publish = (uri: string, text: string, version?: number) => {
  if (silent) return;
  if (encode) uri = uri.replace(/@/g, '%40');
  const diagnostics = text.split('\n').flatMap((line, i) => {
    const err = line.indexOf('ERR');
    const warn = line.indexOf('WARN');
    return [
      ...(err >= 0 ? [{ range: { start: { line: i, character: err }, end: { line: i, character: err + 3 } }, severity: 1, message: `bad thing on line ${i + 1}`, code: 'E1' }] : []),
      ...(warn >= 0 ? [{ range: { start: { line: i, character: warn }, end: { line: i, character: warn + 4 } }, severity: 2, message: 'a warning' }] : []),
    ];
  });
  // In two steps, as servers do: nothing first, then the result.
  send({ method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: [] } });
  setTimeout(() => send({ method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics } }), late);
};

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const head = buf.indexOf('\r\n\r\n');
    if (head < 0) return;
    const length = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, head).toString())?.[1]);
    if (buf.length < head + 4 + length) return;
    const msg = JSON.parse(buf.subarray(head + 4, head + 4 + length).toString());
    buf = buf.subarray(head + 4 + length);
    if (msg.method === 'initialize') {
      setTimeout(() => {
        send({ id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
        send({ id: 'cfg', method: 'workspace/configuration', params: { items: [{ section: 'fake' }] } });
      }, initDelay);
    } else if (msg.method === 'textDocument/didOpen') publish(msg.params.textDocument.uri, msg.params.textDocument.text, msg.params.textDocument.version);
    else if (msg.method === 'shutdown') send({ id: msg.id, result: null });
    else if (msg.method === 'exit') process.exit(0);
  }
});
