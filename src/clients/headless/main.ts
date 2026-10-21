import { readFileSync } from 'node:fs';
import { runPrompt } from '../../core/loop/run.ts';
import { preamble, BASE_SYSTEM } from '../../core/prompts.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import type { FauxStep } from '../../core/providers/faux.ts';
import { missingKeyNote } from '../../core/providers/http.ts';
import { providerFor } from '../../core/providers/index.ts';
import { SessionLog, sessionPath } from '../../core/session/log.ts';
import { loadChecks, loadPolicy } from '../../core/config.ts';
import { CORE_TOOLS } from '../../core/tools/index.ts';
import type { Effort, Evidence, HeadlessResult } from '../../core/types.ts';
import { encode } from '../../protocol/index.ts';

export type HeadlessArgs = {
  prompt: string;
  model: string;
  cwd: string;
  outputFormat: 'text' | 'json' | 'stream-json';
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: Effort;
  noSessionFile?: boolean;
  permission?: string;
  allow?: string[];
  deny?: string[];
  checks?: string[];
};

// Every run that changed files or ran checks ends with a receipt built from the ledger.
export function receipt(ev: Evidence): string {
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');
  const checks = ev.checks.map((c) => `${c.command} (exit ${c.exitCode})`);
  return `cedia receipt: changed ${list(ev.changed)}; checks ${list(checks)}; unverified ${list(ev.unverified)}`;
}

export async function runHeadless(args: HeadlessArgs, out: (s: string) => void = (s) => process.stdout.write(s)): Promise<HeadlessResult> {
  const model = resolveModel(args.model);
  const checks = loadChecks(args.cwd, args.checks);
  const policy = loadPolicy(args.cwd, { ...(args.permission ? { mode: args.permission } : {}), allow: args.allow ?? [], deny: args.deny ?? [] });
  const keyNote = missingKeyNote(model);
  if (keyNote) process.stderr.write(keyNote + '\n');
  const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? (JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) as FauxStep[]) : undefined;
  const id = crypto.randomUUID();
  const log = SessionLog.create({ id, path: args.noSessionFile ? null : sessionPath(args.cwd, id) });
  if (args.outputFormat === 'stream-json') log.listeners.push((event) => out(encode({ type: 'event', event })));

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await runPrompt(
      {
        log,
        provider: providerFor(model, { fauxScript }),
        model,
        tools: CORE_TOOLS,
        system: BASE_SYSTEM,
        preamble: preamble(args.cwd, { mode: policy.mode, checks }),
        cwd: args.cwd,
        permission: policy,
        checks,
        signal: ac.signal,
        ...(args.effort ?? model.defaultEffort ? { effort: args.effort ?? model.defaultEffort } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
        ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
        ...(args.outputFormat === 'stream-json' ? { onStream: (event) => out(encode({ type: 'stream', event })) } : {}),
      },
      args.prompt,
    );
    if (args.outputFormat === 'text') {
      out(result.result + (result.result.endsWith('\n') ? '' : '\n'));
      if (result.evidence) process.stderr.write(receipt(result.evidence) + '\n');
    }
    else out(encode(result));
    return result;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
