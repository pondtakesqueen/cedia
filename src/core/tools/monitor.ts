import { spawn } from 'node:child_process';
import type { ToolSpec } from './registry.ts';

export const monitorTool: ToolSpec = {
  name: 'Monitor',
  description: 'Run a command in the background and collect output lines (optionally filtered) until timeout or exit.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'number' },
      filter: { type: 'string' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  effect: 'exec',
  replay: 'unsafe',
  async run(input, ctx) {
    const command = String(input.command ?? '');
    const timeout = Math.max(100, Math.min(600000, Number(input.timeout_ms ?? 5000)));
    const filter = input.filter ? new RegExp(String(input.filter)) : null;
    return await new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd: ctx.cwd });
      const lines: string[] = [];
      let buf = '';
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, timeout);
      const flush = (chunk: string) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!filter || filter.test(line)) lines.push(line);
        }
      };
      child.stdout?.on('data', (d) => flush(d.toString()));
      child.stderr?.on('data', (d) => flush(d.toString()));
      child.on('close', () => {
        clearTimeout(timer);
        if (buf.trim()) { if (!filter || filter.test(buf)) lines.push(buf); }
        resolve({ text: lines.join('\n') || '(no output)', isError: false });
      });
      child.on('error', (e) => { clearTimeout(timer); resolve({ text: `error: ${e.message}`, isError: true }); });
    });
  },
};
