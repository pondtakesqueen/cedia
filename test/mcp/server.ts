// A fake MCP server for tests, over stdio: one JSON-RPC message a line.
const tools = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'picture', description: 'Returns an image', inputSchema: { type: 'object' } },
  { name: 'slow', description: 'Answers after a while', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'env', description: 'Says which variables it sees', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Exits', inputSchema: { type: 'object', properties: {} } },
];
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
// Noise a careless server prints to stdout.
process.stdout.write('starting up...\n');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});
async function handle(m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }) {
  if (m.method === 'initialize') {
    // Ask the client something it does not support, before answering.
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' });
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  }
  if (m.method === 'tools/list') {
    // Two pages.
    const second = m.params?.cursor === 'p2';
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: second ? tools.slice(3) : tools.slice(0, 3), ...(second ? {} : { nextCursor: 'p2' }) } });
  }
  if (m.method === 'tools/call') {
    const name = m.params?.name;
    const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
    if (name === 'echo') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo: ${args.text}` }] } });
    if (name === 'fail') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } });
    if (name === 'picture') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'text', text: 'a picture' }] } });
    if (name === 'slow') return setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'late' }] } }), Number(args.ms ?? 5000));
    if (name === 'env') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `FAKE_TOKEN=${process.env.FAKE_TOKEN ?? ''} ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? ''}` }] } });
    if (name === 'crash') {
      process.stderr.write('fatal: out of cheese\n');
      process.exit(3);
    }
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `no tool ${name}` } });
  }
  if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
}
