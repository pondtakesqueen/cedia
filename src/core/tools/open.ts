import { resolve } from 'node:path';
import { titleOf, type ThreadStore } from '../project/threads.ts';
import type { ToolSpec } from './registry.ts';

// open_thread: a coordinator (core/profiles.ts) opens a thread of the project for a piece of the work. cedia only
// records it: the thread is `queued`, with the task and the thread that opened it, and whoever runs the project's
// threads (the desktop's daemon) starts its first run, in a worktree of its own, with the task as the prompt. The
// opener follows it with read_thread and message_thread, and the opened thread can message it back. Present when
// the run's profile says so, on a writer session of a thread.

export const OPEN_TOOL = 'open_thread';
// Threads one run may open: a coordinator that splits a task into dozens would start more work than anyone reviews.
export const MAX_OPENS = 8;

// `roots`: the workspace's repository roots (core/session/log.ts workspaceRoots); a thread may be opened in one of
// them or in `root`, the project root this run is in, and nowhere else.
export function openThreadTool(store: ThreadStore, opener: string, opened: { count: number } = { count: 0 }, root?: string, roots: string[] = []): ToolSpec {
  return {
    name: OPEN_TOOL,
    description: `Open a new thread of this project for one piece of the work. It runs in a session of its own, in a worktree of its own, started for you, and sees only the task you write: give it the goal, the facts and paths it needs, what done looks like, and what to report back. Returns its id; follow it with read_thread and tell it something with message_thread. At most ${MAX_OPENS} per run.`,
    schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The complete brief for the thread' },
        title: { type: 'string', description: 'A short name for the thread, a few words (default: the first line of the task)' },
        root: { type: 'string', description: 'The repository root this thread runs in, for a multi-repo workspace (default: the project root this run is in)' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    effect: 'read',
    replay: 'unsafe',
    async run(input) {
      const task = String(input.task ?? '').trim();
      if (!task) return { text: 'task is required', isError: true };
      if (opened.count >= MAX_OPENS) return { text: `not opened: this run has opened ${opened.count} threads, the most it may`, isError: true };
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const asked = typeof input.root === 'string' && input.root.trim() ? resolve(input.root.trim()) : undefined;
      const allowed = [...new Set([...(root ? [root] : []), ...roots])];
      if (asked && !allowed.includes(asked)) return { text: `not opened: ${asked} is not a root of this workspace. Roots: ${allowed.join(', ') || 'none'}`, isError: true };
      const chosenRoot = asked ?? root;
      opened.count++;
      const id = store.open(task, { by: opener, ...(title ? { title } : {}), ...(chosenRoot ? { root: chosenRoot } : {}) });
      return { text: `Opened thread ${id} ("${titleOf(title || task)}"). It is queued and starts on its own; it will message you when it needs you.`, isError: false };
    },
  };
}
