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
  async run(input, _ctx) {
    let ms = Number(input.duration_ms ?? 0);
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    if (ms > 600000) ms = 600000;
    await new Promise((r) => setTimeout(r, ms));
    return { text: `Slept for ${ms} ms`, isError: false };
  },
};
