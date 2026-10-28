import type { ToolSpec } from './registry.ts';

export const sleepTool: ToolSpec = {
  name: 'sleep',
  description: 'Wait for a duration in milliseconds (0 to 600000). No side effects.',
  schema: {
    type: 'object',
    properties: { duration_ms: { type: 'number', description: 'Milliseconds to sleep (0-600000)' } },
    required: ['duration_ms'],
    additionalProperties: false,
  },
  effect: 'read',
  replay: 'safe',
  async run(input, ctx) {
    let ms = Number(input.duration_ms ?? 0);
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    if (ms > 600000) ms = 600000;
    // A stop ends the wait: Esc in the TUI must not sit out ten minutes.
    const stopped = await new Promise<boolean>((r) => {
      if (ctx.signal.aborted) return r(true);
      const done = (aborted: boolean) => () => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        r(aborted);
      };
      const onAbort = done(true);
      const timer = setTimeout(done(false), ms);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
    if (stopped) return { text: 'stopped before the wait was over', isError: true };
    return { text: `Slept for ${ms} ms`, isError: false };
  },
};
