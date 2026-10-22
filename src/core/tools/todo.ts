import type { ThreadStore, TodoItem, TodoState } from '../project/threads.ts';
import type { ToolSpec } from './registry.ts';

// todo: the writer keeps a short list of the steps of its task and marks them as it goes. Each call replaces the
// whole list, and the list goes in the thread's file as a `todo` event, so a client draws the thread's progress
// (3/5 and the step it is on) without reading the session. It is for the owner's view, not the model's memory:
// nothing in it reaches the model again except the tool's own short result. Present when the client asks for it
// (`--todo on`, `todo` in settings), on a writer session of a thread.

export const TODO_TOOL = 'todo';
export const TODO_STATES: TodoState[] = ['pending', 'doing', 'done'];
export const MAX_ITEMS = 20;
const MAX_TEXT = 200;

export function todoOf(input: Record<string, unknown>): TodoItem[] | string {
  const raw = input.items;
  if (!Array.isArray(raw)) return 'items must be a list';
  if (raw.length > MAX_ITEMS) return `at most ${MAX_ITEMS} items`;
  const items: TodoItem[] = [];
  for (const i of raw) {
    const text = typeof i?.text === 'string' ? i.text.trim() : '';
    if (!text) return 'every item needs text';
    if (!TODO_STATES.includes(i.state)) return `an item's state is ${TODO_STATES.join(', ')}`;
    items.push({ text: text.slice(0, MAX_TEXT), state: i.state });
  }
  return items;
}

// "3/5", and the step being done (else the next one to do).
export function progressOf(items: TodoItem[]): { done: number; total: number; now?: string } {
  const now = items.find((i) => i.state === 'doing') ?? items.find((i) => i.state === 'pending');
  return { done: items.filter((i) => i.state === 'done').length, total: items.length, ...(now ? { now: now.text } : {}) };
}

export function todoTool(store: ThreadStore, thread: string, run?: string): ToolSpec {
  return {
    name: TODO_TOOL,
    description:
      'Keep the list of steps for this task, which the owner sees as your progress. Write it once you know the steps (3 to 8 is usual), then call it again whenever a step starts or finishes, with the whole list each time: one step "doing" at a time, finished ones "done". Skip it for a task of one or two steps.',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: MAX_ITEMS,
          items: {
            type: 'object',
            properties: { text: { type: 'string', description: 'The step, in a few words' }, state: { type: 'string', enum: TODO_STATES } },
            required: ['text', 'state'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    effect: 'read',
    replay: 'safe',
    async run(input) {
      const items = todoOf(input);
      if (typeof items === 'string') return { text: items, isError: true };
      store.append(thread, { kind: 'todo', items, ...(run ? { run } : {}) });
      const p = progressOf(items);
      return { text: `Saved: ${p.done}/${p.total} done${p.now ? `; now: ${p.now}` : ''}.`, isError: false };
    },
  };
}
