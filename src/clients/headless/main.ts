import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPrompt } from '../../core/loop/run.ts';
import { preamble, BASE_SYSTEM } from '../../core/prompts.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import type { FauxStep } from '../../core/providers/faux.ts';
import { missingKeyNote } from '../../core/providers/http.ts';
import { providerFor } from '../../core/providers/index.ts';
import { projectSlug, SessionLog, sessionPath } from '../../core/session/log.ts';
import { cediaHome, loadChecks, loadContext, loadPolicy, loadPrivacy, loadSandbox } from '../../core/config.ts';
import { openSandbox } from '../../core/safety/sandbox.ts';
import { openSnapshots } from '../../core/safety/snapshot.ts';
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
  unlock?: string[];
  privacy?: string;
  checks?: string[];
  sandbox?: string;
  allowDomains?: string[];
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
        preamble: preamble(args.cwd, { mode: policy.mode, unlock: policy.unlock ?? [], checks, sandbox, ...(context ? { context } : {}) }),
        cwd: args.cwd,
        permission: policy,
        privacy,
        checks,
        ...(sandbox.on ? { wrap: sandbox.wrap } : {}),
        ...(snapshots ? { snapshots } : {}),
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
    await sandbox.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
