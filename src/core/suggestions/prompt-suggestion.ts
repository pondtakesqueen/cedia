import { runPrompt } from '../loop/run.ts';
import { resolveModel } from '../providers/catalog.ts';
import { providerFor } from '../providers/index.ts';
import { SessionLog } from '../session/log.ts';
import { memoryPath } from '../project/memory.ts';
import type { HeadlessResult } from '../types.ts';

export type Suggestion = { text: string };

export async function generateSuggestion(opts: { cwd: string; model?: string; lastResult: string; privacy?: string }): Promise<Suggestion | null> {
  const { readFileSync } = await import('node:fs');
  const model = resolveModel(opts.model ?? 'beam');
  const script = process.env.CEDIA_FAUX_SCRIPT ? JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) : undefined;
  const log = SessionLog.create({ path: null });
  const r = await runPrompt(
    {
      log,
      provider: providerFor(model, { fauxScript: script }),
      model,
      tools: [],
      system: 'Predict the user\'s next prompt in one short sentence. Reply with only the suggestion.',
      cwd: opts.cwd,
      role: 'suggest',
      maxTurns: 1,
    },
    opts.lastResult || 'continue',
  );
  if (r.subtype !== 'success' || !r.result.trim()) return null;
  return { text: r.result.trim() };
}
