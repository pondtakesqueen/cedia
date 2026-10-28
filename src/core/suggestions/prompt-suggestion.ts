import { runPrompt } from '../loop/run.ts';
import { resolveModel } from '../providers/catalog.ts';
import { providerFor } from '../providers/index.ts';
import { SessionLog } from '../session/log.ts';
import { loadPrivacy } from '../config.ts';

export type Suggestion = { text: string };

// The last reply goes to a model (beam by default, which keeps prompts), so the project's privacy level holds here as
// in any run: under zdr runPrompt refuses a model that is not zero-data-retention and nothing is suggested.
export async function generateSuggestion(opts: { cwd: string; model?: string; lastResult: string }): Promise<Suggestion | null> {
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
      privacy: loadPrivacy(opts.cwd),
      maxTurns: 1,
    },
    opts.lastResult || 'continue',
  );
  if (r.subtype !== 'success' || !r.result.trim()) return null;
  return { text: r.result.trim() };
}
