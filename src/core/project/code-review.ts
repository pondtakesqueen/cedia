import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadPolicy, loadPrivacy } from '../config.ts';
import { runPrompt } from '../loop/run.ts';
import { resolveModel } from '../providers/catalog.ts';
import { providerFor } from '../providers/index.ts';
import { READ_ONLY_SYSTEM } from '../prompts.ts';
import { SessionLog, sessionPath } from '../session/log.ts';
import { CORE_TOOLS } from '../tools/index.ts';
import { askedReviewPrompt, findingRef, parseVerdict, verifyFindings, type Verdict } from '../trust/review.ts';

// `cedia review --thread <id> --json`: the desktop's /code-review card. A read-only session reviews what the
// thread changed (the TUI's /review, on the thread's files) and its FINDING lines come back as findings, each
// with the file and line it names, so a client can group them by file and step through them in a diff.

// One finding. `id` is the same for the same finding text on the same line, so a client can keep a dismissal
// across a re-render; `line` is absent when the finding names no line.
export type CodeFinding = { id: string; path?: string; line?: number; text: string };
// What `cedia review --json` prints: the verdict, the findings in the order the reviewer gave them (most severe
// first), the review's text before its findings, the files it reviewed, and the findings dropped because they
// named a file outside the change; or why there is no review.
export type CodeReview =
  | { model: string; verdict: Verdict; findings: CodeFinding[]; summary: string; files: string[]; dropped: { ref: string; reason: string }[]; costUsd: number }
  | { error: string };

const FINDING = /^\W*FINDING:\s*/i;

// The FINDING lines of a review, as findings. Lines that are not FINDING lines are not findings.
export function parseFindings(findings: string): CodeFinding[] {
  const out: CodeFinding[] = [];
  for (const raw of findings.split('\n')) {
    if (!FINDING.test(raw)) continue;
    const text = raw.replace(FINDING, '').trim();
    if (!text) continue;
    const ref = findingRef(text);
    const id = createHash('sha256').update(`${ref?.path ?? ''}:${ref?.line ?? ''}:${text}`).digest('hex').slice(0, 12);
    out.push({ id, ...(ref ? { path: ref.path, line: ref.line } : {}), text });
  }
  return out;
}

// The text a review gave before its FINDING and VERDICT lines.
const summaryOf = (findings: string) =>
  findings
    .split('\n')
    .filter((l) => !FINDING.test(l) && !/^\W*FINDINGS:\s*none\b/i.test(l))
    .join('\n')
    .trim();

export async function codeReview(opts: { cwd: string; files: string[]; patch: string; model: string; signal?: AbortSignal }): Promise<CodeReview> {
  if (!opts.files.length) return { error: 'nothing this thread changed differs from HEAD' };
  const model = resolveModel(opts.model);
  const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) : undefined;
  const id = crypto.randomUUID();
  const log = SessionLog.create({ id, path: sessionPath(opts.cwd, id) });
  const r = await runPrompt(
    {
      log,
      provider: providerFor(model, { fauxScript }),
      model,
      tools: CORE_TOOLS.filter((t) => t.effect !== 'write_workspace'),
      system: READ_ONLY_SYSTEM,
      cwd: opts.cwd,
      role: 'review',
      permission: { ...loadPolicy(opts.cwd, { allow: [], deny: [], unlock: [] }), mode: 'read-only' },
      privacy: loadPrivacy(opts.cwd),
      maxTurns: 40,
      signal: opts.signal ?? new AbortController().signal,
    },
    // The patch holds the thread's new files whole, so none is left to name as untracked.
    askedReviewPrompt({ kind: 'changes', untracked: [] }, opts.patch),
  );
  if (r.subtype !== 'success') return { error: `the review did not finish (${r.subtype})` };
  const { verdict, findings } = parseVerdict(r.result);
  const placed = verifyFindings(findings, opts.patch);
  return { model: model.ref, verdict, findings: parseFindings(placed.kept), summary: summaryOf(placed.kept), files: opts.files, dropped: placed.dropped, costUsd: r.costUsd };
}
