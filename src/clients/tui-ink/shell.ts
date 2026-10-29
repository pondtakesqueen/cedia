// A prompt that starts with `!` runs in the owner's own shell, in the working directory, like typing it in a
// terminal (OpenCode and Claude Code have the same mode). It is the owner's command, so no permission rule or
// sandbox applies. Its output shows as a Bash row and goes with the owner's next message to the model, so the
// model sees it only as part of a prompt the session log records.

export type ShellRun = { command: string; exitCode: number | null; output: string; ms: number; ended?: 'stopped' | 'timeout' };

export const SHELL_TIMEOUT_MS = 120_000;
// What the model is shown of one command's output: its end, where the result and the errors usually are.
export const SHELL_NOTE_CHARS = 4000;
const KEEP_CHARS = 1_000_000;

/** The command a `!` prompt runs, or undefined when the prompt is not one. */
export function shellCommand(prompt: string): string | undefined {
  const t = prompt.trim();
  return t.startsWith('!') ? t.slice(1).trim() : undefined;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

export async function runOwnerShell(command: string, cwd: string, signal: AbortSignal, timeoutMs = SHELL_TIMEOUT_MS): Promise<ShellRun> {
  const started = Date.now();
  const shell = process.env.SHELL || '/bin/sh';
  // The TUI owns the terminal's input, so the command gets none; a command that waits for input ends at the timeout.
  const proc = Bun.spawn([shell, '-c', command], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CEDIA_SHELL: '1' } });
  let ended: ShellRun['ended'];
  const kill = (why: NonNullable<ShellRun['ended']>) => { ended ??= why; try { proc.kill(); } catch {} };
  const onAbort = () => kill('stopped');
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timer = setTimeout(() => kill('timeout'), timeoutMs);
  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  try {
    const exitCode = await proc.exited;
    // A child the command left running can hold the pipes open; what came before the exit is what it said.
    await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(300)]);
    out.stop();
    err.stop();
    const o = out.text().trimEnd();
    const e = err.text().trimEnd();
    const text = stripAnsi([o, e ? `[stderr]\n${e}` : ''].filter(Boolean).join('\n'));
    return { command, exitCode: ended ? null : exitCode, output: text.length > KEEP_CHARS ? text.slice(-KEEP_CHARS) : text, ms: Date.now() - started, ...(ended ? { ended } : {}) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

// Reads a pipe as it fills, so the command never blocks on a full one, and keeps at most KEEP_CHARS of its end.
function collect(stream: ReadableStream<Uint8Array>): { done: Promise<void>; stop: () => void; text: () => string } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.length > 2 * KEEP_CHARS) buf = buf.slice(-KEEP_CHARS);
      }
    } catch {}
  })();
  return { done, stop: () => { reader.cancel().catch(() => {}); }, text: () => buf };
}

/** How a run ended, in the words the row and the model both get. */
export function shellEnd(run: ShellRun): string {
  if (run.ended === 'stopped') return 'stopped by the owner';
  if (run.ended === 'timeout') return 'stopped at the time limit';
  return `exit ${run.exitCode}`;
}

/** The text that goes before the owner's next message: every command run since the last one, oldest first. */
export function shellNote(runs: ShellRun[]): string {
  if (!runs.length) return '';
  const blocks = runs.map((r) => {
    const out = r.output.length > SHELL_NOTE_CHARS ? `[… ${r.output.length - SHELL_NOTE_CHARS} earlier characters cut]\n${r.output.slice(-SHELL_NOTE_CHARS)}` : r.output;
    return `$ ${r.command}\n(${shellEnd(r)})\n${out || '(no output)'}`;
  });
  return `The owner ran ${runs.length === 1 ? 'this command' : 'these commands'} in their own shell before writing (you did not run ${runs.length === 1 ? 'it' : 'them'}):\n<owner-shell>\n${blocks.join('\n\n')}\n</owner-shell>\n\n`;
}
