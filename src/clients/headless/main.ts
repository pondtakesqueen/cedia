import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPrompt } from '../../core/loop/run.ts';
import { preamble, BASE_SYSTEM } from '../../core/prompts.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import type { FauxStep } from '../../core/providers/faux.ts';
import { missingKeyNote } from '../../core/providers/http.ts';
import { providerFor } from '../../core/providers/index.ts';
import { projectSlug, SessionLog, sessionPath } from '../../core/session/log.ts';
import { cediaHome, detectChecks, loadChecks, loadContext, loadFallback, loadPolicy, loadPrivacy, loadSandbox } from '../../core/config.ts';
import { openSandbox } from '../../core/safety/sandbox.ts';
import { openSnapshots } from '../../core/safety/snapshot.ts';
import { CORE_TOOLS } from '../../core/tools/index.ts';
import { addUsage, hitRatio, type Effort, type Evidence, type HeadlessResult, type ModelSpec, type Provider, type SessionEvent } from '../../core/types.ts';
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
  unlock?: string[];
  privacy?: string;
  fallback?: string;
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

const quotaSpent = (events: SessionEvent[]) => events.findLast((e) => e.kind === 'attempt')?.error?.code === 'quota';

export const continueNote = (from: ModelSpec, sessionId: string) =>
  `A session on ${from.ref} (${sessionId}) stopped partway through this task when its quota ran out. The working tree may already hold part of the work: look at what changed before you go on.`;

// One result for the two sessions: spend and turns add up, the rest is the fallback session's, whose evidence
// already counts the first session's changes.
function merge(first: HeadlessResult, second: HeadlessResult): HeadlessResult {
  const usage = addUsage(first.usage, second.usage);
  const checks = [...(first.evidence?.checks ?? []), ...(second.evidence?.checks ?? [])];
  const flags = [...new Set([...(first.evidence?.flags ?? []), ...(second.evidence?.flags ?? [])])];
  return {
    ...second,
    numTurns: first.numTurns + second.numTurns,
    usage,
    costUsd: first.costUsd + second.costUsd,
    cacheHitRatio: hitRatio(usage),
    ...(second.evidence ? { evidence: { ...second.evidence, checks, ...(flags.length ? { flags } : {}) } } : {}),
  };
}

export async function runHeadless(args: HeadlessArgs, out: (s: string) => void = (s) => process.stdout.write(s)): Promise<HeadlessResult> {
  const model = resolveModel(args.model);
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
  const keyNote = missingKeyNote(model);
  if (keyNote) process.stderr.write(keyNote + '\n');
  const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? (JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) as FauxStep[]) : undefined;
  const openLog = () => {
    const id = crypto.randomUUID();
    const log = SessionLog.create({ id, path: args.noSessionFile ? null : sessionPath(args.cwd, id) });
    if (args.outputFormat === 'stream-json') log.listeners.push((event) => out(encode({ type: 'event', event })));
    return log;
  };
  const basePreamble = preamble(args.cwd, { mode: policy.mode, unlock: policy.unlock ?? [], checks, sandbox, ...(context ? { context } : {}) });

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // Scripted models share one script, so a fallback session reads on from where the first one stopped.
  let faux: Provider | undefined;
  const providerOf = (m: ModelSpec) => (m.wire === 'faux' ? (faux ??= providerFor(m, { fauxScript })) : providerFor(m));
  // A continuing session gets what is left of the turn and budget limits, not a fresh allowance.
  const run = (m: ModelSpec, log: SessionLog, continues?: { from: ModelSpec; sessionId: string; changed: string[]; turns: number; costUsd: number }) =>
    runPrompt(
      {
        log,
        provider: providerOf(m),
        model: m,
        tools: CORE_TOOLS,
        system: BASE_SYSTEM,
        preamble: continues ? `${basePreamble}\n\n${continueNote(continues.from, continues.sessionId)}` : basePreamble,
        cwd: args.cwd,
        permission: policy,
        privacy,
        checks,
        ...(softChecks ? { softChecks } : {}),
        ...(sandbox.on ? { wrap: sandbox.wrap } : {}),
        ...(snapshots ? { snapshots } : {}),
        ...(continues ? { continues: { sessionId: continues.sessionId, changed: continues.changed } } : {}),
        signal: ac.signal,
        ...(args.effort ?? m.defaultEffort ? { effort: args.effort ?? m.defaultEffort } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns - (continues?.turns ?? 0) } : {}),
        ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd - (continues?.costUsd ?? 0) } : {}),
        ...(args.outputFormat === 'stream-json' ? { onStream: (event) => out(encode({ type: 'stream', event })) } : {}),
      },
      args.prompt,
    );
  try {
    const log = openLog();
    let result = await run(model, log);
    // A spent quota does not end the task: a new session on the fallback model picks it up (a session never
    // switches model, so its cache stays valid).
    if (fallback && result.subtype === 'error_during_execution' && quotaSpent(log.events)) {
      process.stderr.write(`cedia: ${model.ref} is out of quota; continuing on ${fallback.ref} in a new session\n`);
      const note = missingKeyNote(fallback);
      if (note) process.stderr.write(note + '\n');
      const changed = result.evidence?.changed ?? [];
      const second = await run(fallback, openLog(), { from: model, sessionId: log.id, changed, turns: result.numTurns, costUsd: result.costUsd });
      result = merge(result, second);
    }
    if (args.outputFormat === 'text') {
      out(result.result + (result.result.endsWith('\n') ? '' : '\n'));
      if (result.evidence) process.stderr.write(receipt(result.evidence) + '\n');
    }
    else out(encode(result));
    return result;
  } finally {
    await sandbox.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
