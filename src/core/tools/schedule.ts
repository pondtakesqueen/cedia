import { minutesOf, MIN_EVERY, scheduleLine, whenOf, type ScheduleStore } from '../project/schedules.ts';
import type { ToolSpec } from './registry.ts';

// schedule: a coordinator (core/profiles.ts) sets a prompt for its own thread to get at a time, once or again every
// so often, when the owner asks for one in the project chat ("check the nightly build every morning"). The daemon
// starts the run at the time (core/project/schedules.ts). It also cancels one, and each call answers with the
// thread's schedules as they stand.

export const SCHEDULE_TOOL = 'schedule';

export function scheduleTool(store: ScheduleStore, thread: string): ToolSpec {
  const mine = () => store.list().filter((s) => s.thread === thread);
  const listed = (head: string) => {
    const all = mine();
    return `${head}\n${all.length ? all.map(scheduleLine).join('\n') : 'This thread has no schedules.'}`;
  };
  return {
    name: SCHEDULE_TOOL,
    description: `Schedule a prompt for this thread: at the time, a new run of this thread starts with it, as if the owner had sent it. Use it when the owner asks for something later or on a cadence ("every morning, check the nightly build and open a thread for a failure"). Give \`at\` as an ISO time with its offset or as a delay ("30m", "2h", "1d"), and \`every\` ("1h", "1d", "1w"; at least ${MIN_EVERY}m) to repeat. \`cancel\` with a schedule's id removes it. Each call lists this thread's schedules.`,
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What this thread is told at the time: a complete instruction' },
        at: { type: 'string', description: 'When: an ISO time with offset, or a delay like "30m" or "2h"' },
        every: { type: 'string', description: 'Repeat this often: "1h", "1d", "1w"' },
        cancel: { type: 'string', description: 'The id of a schedule to remove instead' },
      },
      additionalProperties: false,
    },
    effect: 'read',
    replay: 'unsafe',
    async run(input) {
      if (typeof input.cancel === 'string' && input.cancel) {
        const s = mine().find((x) => x.id === input.cancel);
        if (!s) return { text: listed(`No schedule ${input.cancel} on this thread.`), isError: true };
        store.cancel(s.id);
        return { text: listed(`Cancelled ${s.id}.`), isError: false };
      }
      const prompt = String(input.prompt ?? '').trim();
      if (!prompt && input.at === undefined) return { text: listed('Nothing scheduled.'), isError: false };
      if (!prompt) return { text: 'prompt is required', isError: true };
      const first = whenOf(String(input.at ?? ''));
      if (!first) return { text: 'at must be an ISO time (2026-10-23T09:00:00+07:00) or a delay like "30m" or "2h"', isError: true };
      const every = input.every === undefined ? undefined : minutesOf(String(input.every));
      if (input.every !== undefined && (every === undefined || every < MIN_EVERY)) return { text: `every must be a duration like "1h" or "1d", at least ${MIN_EVERY}m`, isError: true };
      const s = store.add({ prompt, thread, first, ...(every ? { every } : {}), by: thread });
      return { text: listed(`Scheduled ${s.id}.`), isError: false };
    },
  };
}
