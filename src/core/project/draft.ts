import { readFileSync } from 'node:fs';
import { loadPrivacy } from '../config.ts';
import { runPrompt } from '../loop/run.ts';
import { resolveModel } from '../providers/catalog.ts';
import { providerFor } from '../providers/index.ts';
import { SessionLog, sessionPath } from '../session/log.ts';
import { COMMIT_SYSTEM, commitMessage, commitPatch, commitPrompt, recentSubjects } from './commit.ts';

// The commit message for `files`, written by `model` from their diff in a session of its own with no tools, logged
// like any other. The TUI's /commit and `cedia commit` both ask for it; the user sees it before anything commits.
export async function draftCommitMessage(opts: { cwd: string; model: string; files: string[]; privacy?: string; signal?: AbortSignal }): Promise<{ message: string; costUsd: number }> {
  const model = resolveModel(opts.model);
  const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) : undefined;
  const id = crypto.randomUUID();
  const log = SessionLog.create({ id, path: sessionPath(opts.cwd, id) });
  const prompt = commitPrompt(commitPatch(opts.cwd, opts.files), opts.files, recentSubjects(opts.cwd));
  const r = await runPrompt({ log, provider: providerFor(model, { fauxScript }), model, tools: [], system: COMMIT_SYSTEM, cwd: opts.cwd, role: 'commit', privacy: loadPrivacy(opts.cwd, opts.privacy), maxTurns: 2, ...(opts.signal ? { signal: opts.signal } : {}) }, prompt);
  if (r.subtype !== 'success') throw new Error(`the commit message could not be written (${r.subtype}): write one with /commit <message>`);
  return { message: commitMessage(r.result), costUsd: r.costUsd };
}
