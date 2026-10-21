import { readFileSync } from 'node:fs';
import { runPrompt } from '../../core/loop/run.ts';
import { preamble, BASE_SYSTEM } from '../../core/prompts.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import type { FauxStep } from '../../core/providers/faux.ts';
import { missingKeyNote } from '../../core/providers/http.ts';
import { providerFor } from '../../core/providers/index.ts';
import { SessionLog, sessionPath } from '../../core/session/log.ts';
import { bashTool } from '../../core/tools/bash.ts';
import { readTool } from '../../core/tools/read.ts';
import type { Effort, HeadlessResult } from '../../core/types.ts';
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
};

export async function runHeadless(args: HeadlessArgs, out: (s: string) => void = (s) => process.stdout.write(s)): Promise<HeadlessResult> {
  const model = resolveModel(args.model);
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
        tools: [readTool, bashTool],
        system: BASE_SYSTEM,
        preamble: preamble(args.cwd),
        cwd: args.cwd,
        signal: ac.signal,
        ...(args.effort ?? model.defaultEffort ? { effort: args.effort ?? model.defaultEffort } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
        ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
        ...(args.outputFormat === 'stream-json' ? { onStream: (event) => out(encode({ type: 'stream', event })) } : {}),
      },
      args.prompt,
    );
    if (args.outputFormat === 'text') out(result.result + (result.result.endsWith('\n') ? '' : '\n'));
    else out(encode(result));
    return result;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
