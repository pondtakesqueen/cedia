import type { JsonObject, ResultSubtype } from '../types.ts';
import { clip, type ToolSpec } from './registry.ts';
import { inert } from '../trust/frame.ts';

// Sub-threads: a session hands a self-contained piece of work to a child session with a fresh context, and only
// the child's report comes back. The parent's context stays small (the child's reads and dead ends never enter
// it), and the kind decides the rest, so the model picks what the work is and cedia picks how it runs:
//
//   explore  read-only, on the swarm model (cheap and fast); several in one turn run in parallel.
//   work     may write, on the code model, under the run's policy, sandbox and checks. It runs alone, between two
//            snapshots, so the parent's ledger records what it changed and the done gate still wants a check.
//            With worktrees on, each runs in a git worktree of its own instead (core/project/worktree.ts), several
//            at once, and only applying its changes to the parent's files runs alone, between the two snapshots.
//
// A child cannot spawn. A work child whose context grows long hands off to a new session of its own thread, as
// the writer does. One that finishes its task archives its thread; one that fails stays listed.

export type SpawnKind = 'explore' | 'work';
export const SPAWN_KINDS: SpawnKind[] = ['explore', 'work'];
export type SpawnOutcome = {
  thread?: string;
  model: string;
  subtype: ResultSubtype;
  result: string;
  costUsd: number;
  changed: string[];
  unverified: string[];
  // A work sub-thread in a worktree: how its changes came back to the parent's files.
  worktree?: { applied: string[]; refused: string[]; conflicts: string[]; kept?: string; why?: string };
};
export type Spawner = (task: string, kind: SpawnKind, ctx: { signal: AbortSignal; write?: <T>(fn: () => Promise<T> | T) => Promise<T> }) => Promise<SpawnOutcome>;

// What comes back to the parent, at most.
export const MAX_REPORT = 4000;
// Explore sub-threads one run has going at a time, and sub-threads it may start in all: a model that fans out
// on every question would otherwise start dozens of sessions at once and spend without bound.
export const MAX_CONCURRENT_EXPLORE = 4;
export const MAX_CONCURRENT_WORK = 4;
export const MAX_SPAWNS = 16;

export function spawnReport(kind: SpawnKind, o: SpawnOutcome): string {
  const attrs = [o.thread ? `thread="${o.thread}"` : '', `kind="${kind}"`, `model="${o.model}"`, `ended="${o.subtype}"`, `cost="$${o.costUsd.toFixed(4)}"`].filter(Boolean).join(' ');
  const lines = [`<subthread ${attrs}>`, clip(inert(o.result.trim()), MAX_REPORT), '</subthread>'];
  if (o.changed.length) lines.push(`Changed: ${inert(o.changed.join(', '))}${o.unverified.length ? ` (no passing check after: ${inert(o.unverified.join(', '))})` : ''}`);
  const w = o.worktree;
  if (w) {
    // File names are the child's to choose: framed like its report.
    const names = (fs: string[]) => inert(fs.join(', '));
    if (w.applied.length) lines.push(`Applied to your files: ${names(w.applied)}`);
    if (w.conflicts.length) lines.push(`Not applied: its changes conflict with yours (or another sub-thread's) in ${names(w.conflicts)}. Nothing of it was written.`);
    if (w.refused.length) lines.push(`Not applied, since you may not write them: ${names(w.refused)}`);
    if (w.why) lines.push(`Not applied: ${inert(w.why)}.`);
    if (w.kept) lines.push(`Its worktree stays at ${w.kept} for you to read; nothing there reaches your files unless you copy it.`);
  }
  if (o.thread) lines.push(`Its full log stays readable with read_thread ${o.thread}.`);
  return lines.join('\n');
}

const WORK_ALONE = 'kind "work" may edit files, runs alone, and its changes count as yours: run the checks after it.';
const WORK_WORKTREE =
  'kind "work" may edit files. It works in its own copy of your working tree (a git worktree, your uncommitted changes included), so several work calls in one turn run in parallel; give each a part no other touches. Its changes are applied to your files when it finishes, and a change that conflicts with yours or another sub-thread\'s is reported instead of applied. They count as yours: run the checks after it.';

// What one run's spawn tools share, so two of them (one with worktrees, one without, for a resumed session) count
// against the same limits. Sub-threads that run beside others wait for a free slot of their kind. A finished one
// hands its slot straight to the next in line, so no newcomer can take it in between.
export type SpawnPool = { started: number; total: number; slots: Record<SpawnKind, { running: number; max: number; waiting: (() => void)[] }> };
export const spawnPool = (limits = { concurrent: MAX_CONCURRENT_EXPLORE, total: MAX_SPAWNS }, concurrentWork = MAX_CONCURRENT_WORK): SpawnPool => ({
  started: 0,
  total: limits.total,
  slots: { explore: { running: 0, max: limits.concurrent, waiting: [] }, work: { running: 0, max: concurrentWork, waiting: [] } },
});

export function spawnTool(spawn: Spawner, limits?: { concurrent: number; total: number }, opts: { worktrees?: boolean; concurrentWork?: number; pool?: SpawnPool } = {}): ToolSpec {
  const pool = opts.pool ?? spawnPool(limits, opts.concurrentWork);
  const slots = pool.slots;
  const pooled = (kind: SpawnKind) => kind === 'explore' || opts.worktrees === true;
  return {
    name: 'spawn',
    description: `Hand a self-contained piece of work to a sub-thread: a new session with a fresh context that sees only the task you write, and returns one report. Use it to keep your own context small, for work whose details you will not need afterwards: searching or reading across many files to answer one question, investigating a failure, or an independent change you can describe fully. Do it yourself when it takes a few reads or needs what you already know.

kind "explore" reads only, runs on a cheaper fast model, and several explore calls in one turn run in parallel. ${opts.worktrees ? WORK_WORKTREE : WORK_ALONE}

Write the task as a complete brief: the goal, the paths and facts it needs, and what to report back (for example "the file and line where X happens, with the evidence").`,
    schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The complete brief for the sub-thread' },
        kind: { type: 'string', enum: SPAWN_KINDS, description: opts.worktrees ? 'explore: read-only, cheap, parallel. work: may edit files, in its own worktree, parallel' : 'explore: read-only, cheap, parallel. work: may edit files' },
      },
      required: ['task', 'kind'],
      additionalProperties: false,
    },
    effect: 'exec',
    // Explore reads, so it runs in the parallel pool even in a read-only session; work writes.
    effectOf: (input) => (input.kind === 'explore' ? 'read' : 'write_workspace'),
    // In a worktree, work writes the parent's files only through ctx.write, so it runs beside the other calls.
    ...(opts.worktrees ? { isolated: (input: JsonObject) => input.kind === 'work' } : {}),
    replay: 'unsafe',
    async run(input, ctx) {
      const task = String(input.task ?? '').trim();
      const kind = input.kind as SpawnKind;
      if (!task) return { text: 'task is required', isError: true };
      if (!SPAWN_KINDS.includes(kind)) return { text: `kind must be one of ${SPAWN_KINDS.join(', ')}`, isError: true };
      if (pool.started >= pool.total) return { text: `not run: this run has started ${pool.started} sub-threads, the most it may. Do the rest yourself or report what is left`, isError: true };
      pool.started++;
      const slot = pooled(kind) ? slots[kind] : undefined;
      if (slot) {
        if (slot.running < slot.max) slot.running++;
        else await new Promise<void>((r) => slot.waiting.push(r));
      }
      try {
        const o = await spawn(task, kind, { signal: ctx.signal, ...(ctx.write ? { write: ctx.write } : {}) });
        return { text: spawnReport(kind, o), isError: o.subtype !== 'success' || !!o.worktree?.conflicts.length };
      } finally {
        if (slot) {
          const next = slot.waiting.shift();
          if (next) next();
          else slot.running--;
        }
      }
    },
  };
}

// A writer that has spawn is reminded of it once, when its context passes a third of the way to its handoff point:
// in the repo evals Haiku never called spawn on its own, even at 170k, and read every file into its own context.
export const spawnNudgeAt = (handoffAt: number) => Math.round(handoffAt / 3);

export const spawnNudge = (tokens: number) =>
  `Your context is about ${Math.round(tokens / 1000)}k tokens, and every later turn re-sends all of it. From here, hand reading you will not need word for word to the spawn tool: kind "explore" for a question that takes several files to answer (how a flow works, where something is defined, every caller of a function), several in one turn when they are independent. Its report comes back with paths and line numbers; read yourself only the parts of files you are about to edit.`;

export const subtaskPrompt = (task: string, parent: string | undefined, kind: SpawnKind, worktree?: string) =>
  `You are a sub-thread${parent ? ` of thread ${parent}` : ''}: another session handed you this task and will see only your final message. Do this task and nothing else.${kind === 'explore' ? ' You can read and run read-only commands, not edit.' : ''}${worktree ? ` You work in a git worktree of your own at ${worktree}, a copy of the other session's working tree: your changes are applied to its files when you finish. Do not commit. Other sub-threads may be doing other parts of the work at the same time: a check that fails only on a part outside your task is not yours to fix, so say so in your report.` : ''}

<task>
${task}
</task>

End with the report it asked for: findings or changes with paths and line numbers, how you confirmed them, and anything left undone. Keep it short; leave out the steps you took to get there.`;
