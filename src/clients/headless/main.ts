import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPrompt } from '../../core/loop/run.ts';
import { preamble, BASE_SYSTEM } from '../../core/prompts.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import type { FauxStep } from '../../core/providers/faux.ts';
import { missingKeyNote } from '../../core/providers/http.ts';
import { providerFor } from '../../core/providers/index.ts';
import { projectSlug, SessionLog, sessionPath } from '../../core/session/log.ts';
import { cediaHome, detectChecks, loadChecks, loadContext, loadFallback, loadPolicy, loadPrivacy, loadRoles, loadSandbox, type RoleChoice } from '../../core/config.ts';
import { planPrompt, withPlan } from '../../core/roles.ts';
import { openSandbox } from '../../core/safety/sandbox.ts';
import { openSnapshots } from '../../core/safety/snapshot.ts';
import { CORE_TOOLS } from '../../core/tools/index.ts';
import { fixPrompt, parseVerdict, reviewPrompt, type ReviewOutcome } from '../../core/trust/review.ts';
import { addUsage, hitRatio, ZERO_USAGE, type Effort, type EventOf, type Evidence, type HeadlessResult, type ModelSpec, type Provider, type SessionEvent, type Step, type Timing } from '../../core/types.ts';
import { runClaudeCode } from './claude-code.ts';
import { encode } from '../../protocol/index.ts';

export type HeadlessArgs = {
  prompt: string;
  // The code role; plan and review are the other two. Each falls back to settings, then the defaults.
  model?: string;
  plan?: string;
  cwd: string;
  outputFormat: 'text' | 'json' | 'stream-json';
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: Effort;
  noSessionFile?: boolean;
  permission?: string;
  allow?: string[];
  deny?: string[];
  unlock?: string[];
  privacy?: string;
  fallback?: string;
  // Reviews the change once the writer's claim passes the done gate.
  review?: string;
  checks?: string[];
  sandbox?: string;
  allowDomains?: string[];
};

// Every run that changed files or ran checks ends with a receipt built from the ledger.
export function receipt(ev: Evidence): string {
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');
  const checks = ev.checks.map((c) => `${c.command} (exit ${c.exitCode})`);
  return `cedia receipt: changed ${list(ev.changed)}; checks ${list(checks)}; unverified ${list(ev.unverified)}${ev.flags?.length ? `; flagged ${ev.flags.join(', ')}` : ''}`;
}

// What a reviewer may call: everything but the tools that write files. Bash stays, under a read-only policy.
const REVIEW_TOOLS = CORE_TOOLS.filter((t) => t.effect !== 'write_workspace');

// Read-only git for a reviewer in Claude Code, in its permission-rule syntax.
const GIT_READS = ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];

const quotaSpent = (events: SessionEvent[]) => events.findLast((e) => e.kind === 'attempt')?.error?.code === 'quota';

export const continueNote = (from: ModelSpec, sessionId: string) =>
  `A session on ${from.ref} (${sessionId}) stopped partway through this task when its quota ran out. The working tree may already hold part of the work: look at what changed before you go on.`;

// One result for a run made of several sessions (quota fallback, review, fix): spend and turns add up, changed
// files and checks are pooled, and the rest is the last writer session's. A fallback session's evidence already
// counts the first session's changes; a fix session's unverified list is the one that still stands.
function combine(parts: HeadlessResult[], last: HeadlessResult): HeadlessResult {
  const usage = parts.reduce((u, r) => addUsage(u, r.usage), ZERO_USAGE);
  const evs = parts.flatMap((r) => (r.evidence ? [r.evidence] : []));
  const flags = [...new Set(evs.flatMap((e) => e.flags ?? []))];
  const evidence: Evidence | undefined = evs.length
    ? {
        changed: [...new Set(evs.flatMap((e) => e.changed))],
        checks: evs.flatMap((e) => e.checks),
        unverified: last.evidence?.unverified ?? [],
        ...(flags.length ? { flags } : {}),
      }
    : undefined;
  // Time adds up too; the decode rate is all output over all decode time.
  const timed = parts.flatMap((r) => (r.timing ? [{ t: r.timing, out: r.usage.output }] : []));
  const sum = (k: Exclude<keyof Timing, 'outputTokPerSec'>) => timed.reduce((n, x) => n + x.t[k], 0);
  const decodeSec = timed.reduce((n, x) => n + (x.t.outputTokPerSec > 0 ? x.out / x.t.outputTokPerSec : 0), 0);
  const decoded = timed.reduce((n, x) => n + (x.t.outputTokPerSec > 0 ? x.out : 0), 0);
  const timing: Timing | undefined = timed.length
    ? { wallMs: sum('wallMs'), modelMs: sum('modelMs'), ttftMs: sum('ttftMs'), toolMs: sum('toolMs'), retryMs: sum('retryMs'), harnessMs: sum('harnessMs'), outputTokPerSec: decodeSec > 0 ? Math.round((decoded / decodeSec) * 10) / 10 : 0 }
    : undefined;
  const { evidence: _, timing: __, ...rest } = last;
  return {
    ...rest,
    ...(timing ? { timing } : {}),
    numTurns: parts.reduce((n, r) => n + r.numTurns, 0),
    usage,
    costUsd: parts.reduce((c, r) => c + r.costUsd, 0),
    cacheHitRatio: hitRatio(usage),
    ...(evidence ? { evidence } : {}),
  };
}

export async function runHeadless(args: HeadlessArgs, out: (s: string) => void = (s) => process.stdout.write(s)): Promise<HeadlessResult> {
  const roles = loadRoles({ ...(args.model ? { code: args.model } : {}), ...(args.plan ? { plan: args.plan } : {}), ...(args.review ? { review: args.review } : {}) });
  const model = roles.code;
  const declared = loadChecks(args.cwd, args.checks);
  const checks = declared.length ? declared : detectChecks(args.cwd);
  const softChecks = !declared.length && checks.length > 0;
  const privacy = loadPrivacy(args.cwd, args.privacy);
  const context = loadContext();
  const sandboxSettings = loadSandbox({ ...(args.sandbox ? { mode: args.sandbox } : {}), allowDomains: args.allowDomains ?? [] });
  const { sandbox, note: sandboxNote } = await openSandbox(args.cwd, sandboxSettings.mode, { allowedDomains: sandboxSettings.allowedDomains, cediaHome: cediaHome() });
  if (sandboxNote) process.stderr.write(sandboxNote + '\n');
  const policyFlags = { ...(args.permission ? { mode: args.permission } : {}), allow: args.allow ?? [], deny: args.deny ?? [], unlock: args.unlock ?? [] };
  let policy;
  try {
    policy = loadPolicy(args.cwd, policyFlags, process.env, sandbox.on);
  } catch (e) {
    await sandbox.close();
    throw e;
  }
  if (!sandbox.on && policy.mode === 'read-only' && !args.permission && !process.env.CEDIA_PERMISSION)
    process.stderr.write('cedia: the sandbox is off, so this session is read-only. Use --permission workspace to allow writes without it.\n');
  const snapshots = openSnapshots(args.cwd, join(cediaHome(), 'snapshots', projectSlug(args.cwd)), [cediaHome(), ...sandbox.placeholders]);
  const fallback = loadFallback(model, args.fallback);
  for (const m of [model, ...[roles.plan, roles.review].flatMap((r) => (r?.via === 'cedia' ? [r.model] : []))]) {
    const note = missingKeyNote(m);
    if (note) process.stderr.write(note + '\n');
  }
  const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? (JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) as FauxStep[]) : undefined;
  const openLog = () => {
    const id = crypto.randomUUID();
    const log = SessionLog.create({ id, path: args.noSessionFile ? null : sessionPath(args.cwd, id) });
    if (args.outputFormat === 'stream-json') log.listeners.push((event) => out(encode({ type: 'event', event })));
    return log;
  };
  const reviewPreamble = preamble(args.cwd, { mode: 'read-only', sandbox, ...(context ? { context } : {}) });
  // The change the writer's session made: its first snapshot (taken before the first write) to its last.
  const changesPatch = (events: SessionEvent[]): string | undefined => {
    const snaps = events.filter((e): e is EventOf<'snapshot'> => e.kind === 'snapshot');
    if (!snapshots || snaps.length < 2) return undefined;
    try {
      return snapshots.patch(snaps[0]!.tree, snaps.at(-1)!.tree);
    } catch {
      return undefined;
    }
  };
  const basePreamble = preamble(args.cwd, { mode: policy.mode, unlock: policy.unlock ?? [], checks, sandbox, ...(context ? { context } : {}) });

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // Scripted models share one script, so a later session reads on from where the last one stopped.
  let faux: Provider | undefined;
  const providerOf = (m: ModelSpec) => (m.wire === 'faux' ? (faux ??= providerFor(m, { fauxScript })) : providerFor(m));
  // Every session of the run draws on one turn and budget allowance.
  const parts: HeadlessResult[] = [];
  const spent = () => ({ turns: parts.reduce((n, r) => n + r.numTurns, 0), costUsd: parts.reduce((c, r) => c + r.costUsd, 0) });
  const run = async (m: ModelSpec, log: SessionLog, prompt: string, opts: { continues?: { from: ModelSpec; sessionId: string; changed: string[] }; role?: 'plan' | 'review' } = {}) => {
    const { continues } = opts;
    const reviewer = opts.role !== undefined; // plan and review both read and never write
    const used = spent();
    const result = await runPrompt(
      {
        log,
        provider: providerOf(m),
        model: m,
        // Plan and review get no write tools, and their policy is read-only whatever the run's mode.
        tools: reviewer ? REVIEW_TOOLS : CORE_TOOLS,
        system: BASE_SYSTEM,
        preamble: reviewer ? reviewPreamble : continues ? `${basePreamble}\n\n${continueNote(continues.from, continues.sessionId)}` : basePreamble,
        cwd: args.cwd,
        // They may also run the declared checks, to see what fails instead of only reading.
        permission: reviewer ? { ...policy, mode: 'read-only', allow: [...policy.allow, ...checks.map((c) => `bash(${c})`)] } : policy,
        privacy,
        checks: reviewer ? [] : checks,
        ...(softChecks && !reviewer ? { softChecks } : {}),
        ...(sandbox.on ? { wrap: sandbox.wrap } : {}),
        ...(snapshots && !reviewer ? { snapshots } : {}),
        ...(continues ? { continues: { sessionId: continues.sessionId, changed: continues.changed } } : {}),
        ...(opts.role ? { role: opts.role } : {}),
        signal: ac.signal,
        ...(args.effort ?? m.defaultEffort ? { effort: args.effort ?? m.defaultEffort } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns - used.turns } : {}),
        ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd - used.costUsd } : {}),
        ...(args.outputFormat === 'stream-json' ? { onStream: (event) => out(encode({ type: 'stream', event })) } : {}),
      },
      prompt,
    );
    parts.push(result);
    return result;
  };
  // A plan or review step, in cedia or through the user's own Claude Code.
  const side = async (role: 'plan' | 'review', choice: RoleChoice, prompt: string): Promise<{ ok: boolean; text: string; step: Step }> => {
    if (choice.via === 'claude-code') {
      const step: Step = { model: `claude-code:${choice.model}`, via: 'claude-code', sessionId: '' };
      if (privacy === 'zdr') {
        process.stderr.write(`cedia: privacy is zdr, so the ${role} step does not go to Claude Code\n`);
        return { ok: false, text: '', step };
      }
      const allowed = ['Read', 'Grep', 'Glob', ...(role === 'review' ? GIT_READS : []), ...checks.map((c) => `Bash(${c})`)];
      const r = await runClaudeCode({ prompt, model: choice.model, cwd: args.cwd, allowed, signal: ac.signal });
      if (!r.ok) process.stderr.write(`cedia: the ${role} step in Claude Code failed: ${r.error}\n`);
      return { ok: r.ok, text: r.text, step: { ...step, sessionId: r.sessionId, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) } };
    }
    const log = openLog();
    const r = await run(choice.model, log, prompt, { role });
    if (r.subtype !== 'success') process.stderr.write(`cedia: the ${role} step on ${choice.model.ref} ended with ${r.subtype}\n`);
    return { ok: r.subtype === 'success', text: r.result, step: { model: choice.model.ref, via: 'cedia', sessionId: log.id, costUsd: r.costUsd } };
  };
  try {
    // Plan: a stronger model reads the repo and writes the plan the writer gets with the task.
    let task = args.prompt;
    let plan: Step | undefined;
    if (roles.plan) {
      const p = await side('plan', roles.plan, planPrompt(args.prompt));
      if (p.ok && p.text.trim()) {
        task = withPlan(args.prompt, p.text.trim(), p.step.model);
        plan = p.step;
      } else process.stderr.write('cedia: going on without a plan\n');
    }
    let writer = { model, log: openLog() };
    let result = await run(model, writer.log, task);
    // A spent quota does not end the task: a new session on the fallback model picks it up (a session never
    // switches model, so its cache stays valid).
    if (fallback && result.subtype === 'error_during_execution' && quotaSpent(writer.log.events)) {
      process.stderr.write(`cedia: ${model.ref} is out of quota; continuing on ${fallback.ref} in a new session\n`);
      const note = missingKeyNote(fallback);
      if (note) process.stderr.write(note + '\n');
      const changed = result.evidence?.changed ?? [];
      const from = writer;
      writer = { model: fallback, log: openLog() };
      result = await run(fallback, writer.log, task, { continues: { from: from.model, sessionId: from.log.id, changed } });
    }
    // Review: after the writer's claim passed the done gate, a second model reads the change. Changes it asks
    // for go back to the writer's own session once.
    let review: ReviewOutcome | undefined;
    if (roles.review && result.subtype === 'success' && result.evidence?.changed.length) {
      const r = await side('review', roles.review, reviewPrompt(args.prompt, result.evidence, changesPatch(writer.log.events)));
      const { verdict, findings } = r.ok ? parseVerdict(r.text) : { verdict: 'unclear' as const, findings: '' };
      review = { ...r.step, verdict, fixed: false };
      if (verdict === 'changes') {
        result = await run(writer.model, writer.log, fixPrompt(r.step.model, findings));
        review.fixed = true;
      } else if (verdict === 'unclear') process.stderr.write(`cedia: the review by ${r.step.model} gave no verdict; keeping the change as it is\n`);
    }
    result = { ...combine(parts, result), ...(plan ? { plan } : {}), ...(review ? { review } : {}) };
    if (args.outputFormat === 'text') {
      out(result.result + (result.result.endsWith('\n') ? '' : '\n'));
      if (result.evidence) process.stderr.write(receipt(result.evidence) + '\n');
      if (result.plan) process.stderr.write(`cedia plan: by ${result.plan.model}\n`);
      if (result.review) process.stderr.write(`cedia review: ${result.review.model} ${result.review.verdict === 'changes' ? 'asked for changes, sent back to the writer once' : result.review.verdict === 'approve' ? 'approved' : 'gave no verdict'}\n`);
    }
    else out(encode(result));
    return result;
  } finally {
    await sandbox.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
