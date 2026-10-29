import { commandEnv } from './bash.ts';
import { clip, MAX_SHELL_OUTPUT_CHARS, preview, type ToolSpec } from './registry.ts';

// What a watch holds in memory: a chatty command (`yes`, a dev server) left for ten minutes must not grow without end.
const MAX_HELD_CHARS = 4_000_000;

// Runs the command the way bash does: inside the OS sandbox when one is on, without cedia's credentials or a
// shell startup file, in its own process group so a timeout or an abort ends what it started too. The policy
// holds it to bash's deny list and rules (core/safety/policy.ts).
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
    let filter: RegExp | null;
    try {
      filter = input.filter ? new RegExp(String(input.filter)) : null;
    } catch (e) {
      return { text: `invalid filter: ${(e as Error).message}`, isError: true };
    }
    const script = ctx.wrap ? await ctx.wrap(command) : command;
    const proc = Bun.spawn(['bash', '--noprofile', '--norc', '-c', script], { cwd: ctx.cwd, env: commandEnv(), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', detached: true });
    let stopped = '';
    const kill = (why: string) => () => {
      stopped ||= why;
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        proc.kill('SIGTERM');
      }
    };
    const onAbort = kill('aborted');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    const timer = setTimeout(kill('timeout'), timeout);
    const lines: string[] = [];
    let held = 0;
    let dropped = 0;
    const keep = (line: string) => {
      if (filter && !filter.test(line)) return;
      if (held + line.length + 1 > MAX_HELD_CHARS) return void dropped++;
      lines.push(line);
      held += line.length + 1;
    };
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          keep(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      buf += decoder.decode();
      if (buf.trim()) keep(buf);
    };
    const [code] = await Promise.all([proc.exited, read(proc.stdout), read(proc.stderr)]);
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
    let full = lines.join('\n');
    if (dropped) full += `\n[${dropped} later line(s) not kept: the watch holds at most ${MAX_HELD_CHARS} characters]`;
    // Long output goes whole to a file with its start and end shown, as bash's does.
    const path = full.length > MAX_SHELL_OUTPUT_CHARS ? ctx.spill?.(full) : undefined;
    const text = (path ? preview(full, path, MAX_SHELL_OUTPUT_CHARS) : clip(full, MAX_SHELL_OUTPUT_CHARS)) || '(no output)';
    if (stopped === 'aborted') return { text: `${text}\n[aborted]`, isError: true };
    // Stopping at the timeout is how a watch ends, not a failure.
    if (stopped === 'timeout') return { text, isError: false };
    return { text: code === 0 ? text : `${text}\n[exit ${code}]`, isError: code !== 0 };
  },
};
