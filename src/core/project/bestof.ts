import type { ResultSubtype } from '../types.ts';

// Best of N: a work task the writer can see more than one way to do goes to several work sub-threads at once,
// one approach each, each in a worktree of its own (worktree.ts). When all have ended, cedia runs the run's checks
// in every worktree itself and keeps the one that passes most of them: only its changes are merged back into the
// parent's files, and the others' worktrees go. Checks cedia ran, not the children's own claims, decide, so two
// children are judged by the same commands on the same footing. The parent's done gate still wants a check after.

export const MIN_APPROACHES = 2;
export const MAX_APPROACHES = 4;

export type Try = {
  approach: string;
  thread?: string;
  subtype: ResultSubtype;
  // The run's checks cedia ran in its worktree, and how many exited 0.
  passed: number;
  checks: number;
  // Files it changed with no passing check after, by its own ledger.
  unverified: number;
  costUsd: number;
};

// The approaches the model gave, or why they cannot be run.
export function approachesOf(input: unknown): string[] | { error: string } | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.some((a) => typeof a !== 'string' || !a.trim())) return { error: 'approaches must be a list of non-empty strings' };
  const list = [...new Set(input.map((a: string) => a.trim()))];
  if (list.length < MIN_APPROACHES || list.length > MAX_APPROACHES) return { error: `approaches takes ${MIN_APPROACHES} to ${MAX_APPROACHES} different approaches` };
  return list;
}

// The best try: most checks passed, then one that ended in success, then the fewest files left unverified,
// then the cheapest; the earliest on a tie. Undefined when none ended at all (all stopped).
export function bestTry(tries: Try[]): number | undefined {
  const rank = (t: Try) => [t.passed, t.subtype === 'success' ? 1 : 0, -t.unverified, -t.costUsd];
  let best: number | undefined;
  for (let i = 0; i < tries.length; i++) {
    if (tries[i]!.subtype === 'interrupted') continue;
    if (best === undefined) {
      best = i;
      continue;
    }
    const [a, b] = [rank(tries[i]!), rank(tries[best]!)];
    const k = a.findIndex((v, j) => v !== b[j]);
    if (k >= 0 && a[k]! > b[k]!) best = i;
  }
  return best;
}

export const approachBrief = (task: string, approach: string, n: number) =>
  `${task}\n\nTake this approach: ${approach}\n\n${n - 1} other sub-thread${n > 2 ? 's try' : ' tries'} other approaches to the same task at the same time. When all have ended, the run's checks decide which one is kept; the others' changes are dropped. So make your approach pass the checks, and say in your report where it falls short.`;

export function bestOfReport(tries: Try[], kept: number | undefined): string {
  const line = (t: Try, i: number) => `${i + 1}. ${t.approach.split('\n')[0]!.slice(0, 120)}: ${t.checks ? `${t.passed}/${t.checks} checks passed` : 'no checks to run'}, ended ${t.subtype}${t.thread ? `, thread ${t.thread}` : ''}${i === kept ? ' (kept)' : ''}`;
  return [`Best of ${tries.length}: ${kept === undefined ? 'none was kept, since all were stopped' : `kept approach ${kept + 1}; the others' changes were dropped`}.`, ...tries.map(line)].join('\n');
}
