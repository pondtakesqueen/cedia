import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildMessages, sessionHeader } from '../context/build.ts';
import { hash } from '../hash.ts';
import { costUsd } from '../providers/catalog.ts';
import { isRetryable } from '../providers/http.ts';
import { decide, READ_ONLY_POLICY, type Policy } from '../safety/policy.ts';
import { redactSecrets } from '../safety/secrets.ts';
import type { Snapshots } from '../safety/snapshot.ts';
import type { SessionLog } from '../session/log.ts';
import { evidence, ledgerEntries, verified } from '../trust/ledger.ts';
import { effectOf, toolDefs, type ToolSpec } from '../tools/registry.ts';
import {
  addUsage,
  hitRatio,
  ZERO_USAGE,
  type AssistantBlock,
  type AttemptError,
  type Effort,
  type EventOf,
  type HeadlessResult,
  type ModelSpec,
  type PrivacyLevel,
  type Provider,
  type ResultSubtype,
  type SessionEvent,
  type StopReason,
  type StreamEvent,
  type TurnEndReason,
  type Usage,
  type WireRequest,
} from '../types.ts';

export type RunOptions = {
  log: SessionLog;
  provider: Provider;
  model: ModelSpec;
  tools: ToolSpec[];
  system: string;
  // Per-session facts (cwd, date) go in the first user turn, never in the cached system prompt.
  preamble?: string;
  cwd: string;
  // Defaults to read-only: nothing writes unless the caller opts in.
  permission?: Policy;
  // Defaults to no-training.
  privacy?: PrivacyLevel;
  // Declared checks (task or repo). The done gate counts only these, never a command the model picked.
  checks?: string[];
  // Puts bash inside the OS sandbox; absent means unsandboxed.
  wrap?: (command: string) => Promise<string>;
  // Shadow-git snapshots around every writing call; absent means changed files come from edit/write only.
  snapshots?: Snapshots;
  role?: string;
  effort?: Effort;
  ttl?: '5m' | '1h';
  maxTurns?: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  onStream?: (e: StreamEvent) => void;
  retry?: { max?: number; baseMs?: number; capMs?: number; sleep?: (ms: number) => Promise<void> };
  now?: () => Date;
};

export const CONTINUE_AFTER_LIMIT = 'Your previous reply was cut off by the output limit. Continue exactly where it stopped.';

export const unverifiedReminder = (checks: string[]) =>
  `cedia has no record of a declared check passing since your last change, so the task is not done yet. A check counts only when the whole bash command is ${checks.map((c) => `\`${c}\``).join(' or ')} (a leading \`cd\` to the working directory is fine; pipes, \`;\` or other commands are not). Run it that way now, fix what fails, then report.`;

// Hash header values so the log can show which headers were sent without holding secrets.
export function redactHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), hash(v)]));
}

export function isPublicRepo(cwd: string): boolean {
  return existsSync(join(cwd, '.cedia', 'public'));
}

// Rebuilds the exact request a `request` event was written for, from the log alone.
export function rebuildRequest(events: SessionEvent[], requestIndex: number, model: ModelSpec, sessionId: string): WireRequest {
  const header = sessionHeader(events);
  const req = events[requestIndex] as EventOf<'request'>;
  return {
    model,
    sessionId,
    system: header.system,
    tools: header.tools,
    messages: buildMessages(events.slice(0, requestIndex)),
    ...(req.effort ? { effort: req.effort } : {}),
    maxTokens: model.maxOutput,
    ...(req.ttl ? { ttl: req.ttl } : {}),
  };
}

type Collected = { ok: true; blocks: AssistantBlock[]; stop: StopReason; usage: Usage } | { ok: false; error: AttemptError } | { ok: 'aborted' };

async function collect(provider: Provider, req: WireRequest, signal: AbortSignal, onStream?: (e: StreamEvent) => void): Promise<Collected> {
  try {
    for await (const ev of provider.stream(req, signal)) {
      onStream?.(ev);
      if (ev.type === 'error') return { ok: false, error: ev.error };
      if (ev.type === 'done') return ev.stop === 'aborted' ? { ok: 'aborted' } : { ok: true, blocks: ev.blocks, stop: ev.stop, usage: ev.usage };
      if (signal.aborted) return { ok: 'aborted' };
    }
  } catch (err) {
    if (signal.aborted) return { ok: 'aborted' };
    return { ok: false, error: { code: 'network', message: err instanceof Error ? err.message : String(err) } };
  }
  return signal.aborted ? { ok: 'aborted' } : { ok: false, error: { code: 'network', message: 'stream ended without a result' } };
}

const callIdOf = (b: Extract<AssistantBlock, { type: 'tool_use' }>) => b.callId ?? b.id;

export async function runPrompt(opts: RunOptions, prompt: string): Promise<HeadlessResult> {
  const { log, provider, model, tools } = opts;
  const signal = opts.signal ?? new AbortController().signal;
  const now = opts.now ?? (() => new Date());
  const maxTurns = opts.maxTurns ?? 50;
  const retryMax = opts.retry?.max ?? 5;
  const sleep = opts.retry?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const byName = new Map(tools.map((t) => [t.name, t]));

  if (!log.events.length)
    log.append({ kind: 'session', cwd: opts.cwd, role: opts.role ?? 'code', model: model.ref, system: opts.system, tools: toolDefs(tools) });
  const header = sessionHeader(log.events);

  let usage: Usage = { ...ZERO_USAGE };
  let cost = 0;
  let turns = 0;
  let lastText = '';

  const checks = opts.checks ?? [];
  let runStart = log.events.length;
  const entries = () => ledgerEntries(log.events.slice(runStart), checks, opts.cwd);
  let nudged = false;
  const snap: { tree?: string } = {};

  const finish = (subtype: ResultSubtype, reason: TurnEndReason, result?: string): HeadlessResult => {
    log.append({ kind: 'turn_end', reason, ...(reason === 'aborted' ? { cause: 'user' as const } : {}) });
    const ev = evidence(entries());
    const hasEvidence = ev.changed.length > 0 || ev.checks.length > 0;
    return {
      type: 'result',
      subtype,
      sessionId: log.id,
      numTurns: turns,
      usage,
      costUsd: cost,
      cacheHitRatio: hitRatio(usage),
      result: result ?? lastText,
      ...(hasEvidence ? { evidence: ev } : {}),
    };
  };

  if (model.dataPolicy === 'trains' && !isPublicRepo(opts.cwd)) {
    return finish('error_during_execution', 'error', `${model.ref} trains on prompts; it runs only in repos marked public with a .cedia/public file`);
  }
  if (opts.privacy === 'zdr' && model.dataPolicy !== 'zdr') {
    return finish('error_during_execution', 'error', `${model.ref} keeps prompts (${model.dataPolicy}); privacy is set to zdr, so only zero-data-retention models may see this repo`);
  }

  if (opts.preamble && !log.events.some((e) => e.kind === 'user')) log.append({ kind: 'reminder', as: 'user', text: opts.preamble });
  runStart = log.events.length;
  log.append({ kind: 'user', text: prompt });

  while (true) {
    if (signal.aborted) return finish('interrupted', 'aborted');
    if (turns >= maxTurns) return finish('error_max_turns', 'max_turns');
    turns++;

    const req: WireRequest = {
      model,
      sessionId: log.id,
      system: header.system,
      tools: header.tools,
      messages: buildMessages(log.events),
      ...(opts.effort ? { effort: opts.effort } : {}),
      maxTokens: model.maxOutput,
      ...(opts.ttl ? { ttl: opts.ttl } : {}),
    };
    const request = log.append({
      kind: 'request',
      model: model.ref,
      ...(opts.effort ? { effort: opts.effort } : {}),
      toolsHash: hash(header.tools),
      systemHash: hash(header.system),
      bodyHash: hash(provider.body(req)),
      ...(opts.ttl ? { ttl: opts.ttl } : {}),
      headers: redactHeaders(provider.headers(req)),
    });

    let got: Collected | undefined;
    for (let n = 1; ; n++) {
      got = await collect(provider, req, signal, opts.onStream);
      if (got.ok === 'aborted') {
        log.append({ kind: 'attempt', requestId: request.id, n, error: { code: 'network', message: 'aborted' } });
        log.append({ kind: 'assistant', wire: provider.wire, model: model.ref, blocks: [], stop: 'aborted', usage: { ...ZERO_USAGE } });
        return finish('interrupted', 'aborted');
      }
      if (got.ok) {
        log.append({ kind: 'attempt', requestId: request.id, n });
        break;
      }
      log.append({ kind: 'attempt', requestId: request.id, n, error: got.error });
      if (!isRetryable(got.error) || n >= retryMax) return finish('error_during_execution', 'error', got.error.message);
      const base = opts.retry?.baseMs ?? 1000;
      const cap = opts.retry?.capMs ?? 30_000;
      await sleep(got.error.retryAfterMs ?? Math.min(cap, base * 2 ** (n - 1)));
      if (signal.aborted) return finish('interrupted', 'aborted');
    }
    if (!got.ok) throw new Error('unreachable');

    log.append({ kind: 'assistant', wire: provider.wire, model: model.ref, blocks: got.blocks, stop: got.stop, usage: got.usage });
    usage = addUsage(usage, got.usage);
    cost += costUsd(model, got.usage, now());
    const text = got.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (text) lastText = text;

    const calls = got.blocks.filter((b): b is Extract<AssistantBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    const overBudget = opts.maxBudgetUsd !== undefined && cost >= opts.maxBudgetUsd;

    if (calls.length) {
      if (overBudget || signal.aborted) {
        for (const c of calls)
          log.append({ kind: 'tool_result', callId: callIdOf(c), status: 'not_started', output: { text: 'not run: the session stopped', isError: true } });
        return overBudget ? finish('error_max_budget_usd', 'budget') : finish('interrupted', 'aborted');
      }
      await runTools(calls, byName, opts, signal, log, snap);
      continue;
    }
    if (overBudget) return finish('error_max_budget_usd', 'budget');
    if (got.stop === 'max_tokens') {
      log.append({ kind: 'reminder', as: 'user', text: CONTINUE_AFTER_LIMIT });
      continue;
    }
    // Done gate: one reminder to run a declared check, then the claim is refused.
    if (!verified(entries(), checks)) {
      if (!nudged) {
        nudged = true;
        log.append({ kind: 'reminder', as: 'user', text: unverifiedReminder(checks) });
        continue;
      }
      return finish('error_unverified_claim', 'completed');
    }
    return finish('success', 'completed');
  }
}

// The policy decides each call first; a denied call gets a denied result and no intent.
// Intents are written in block order; read-only calls run together, anything else runs alone (an ordering barrier).
async function runTools(
  calls: Extract<AssistantBlock, { type: 'tool_use' }>[],
  byName: Map<string, ToolSpec>,
  opts: RunOptions,
  signal: AbortSignal,
  log: SessionLog,
  snap: { tree?: string },
) {
  type Job = { callId: string; spec: ToolSpec; input: Record<string, unknown>; parallel: boolean };
  const results = new Map<string, EventOf<'tool_result'>['output'] & { status: EventOf<'tool_result'>['status'] }>();
  const jobs: Job[] = [];
  for (const c of calls) {
    const callId = callIdOf(c);
    const spec = byName.get(c.name);
    if (c.inputError) results.set(callId, { status: 'not_started', text: `not run: ${c.inputError}`, isError: true });
    else if (!spec) results.set(callId, { status: 'not_started', text: `not run: unknown tool "${c.name}"`, isError: true });
    else {
      const d = decide(opts.permission ?? READ_ONLY_POLICY, spec, c.input, opts.cwd);
      log.append({ kind: 'permission', callId, tool: c.name, ...d });
      if (d.decision === 'deny') {
        results.set(callId, { status: 'denied', text: `denied (${d.rule}): ${d.reason}. Do not retry it another way; tell the user what you needed.`, isError: true });
        continue;
      }
      log.append({ kind: 'tool_intent', callId, tool: c.name, input: c.input });
      const effect = effectOf(spec, c.input);
      jobs.push({ callId, spec, input: c.input, parallel: effect === 'read' || effect === 'network' });
    }
  }
  const run = async (j: Job) => {
    try {
      const out = await j.spec.run(j.input, { cwd: opts.cwd, signal, ...(opts.wrap ? { wrap: opts.wrap } : {}) });
      results.set(j.callId, { ...out, status: signal.aborted ? 'interrupted_safe' : out.isError ? 'failed' : 'completed' });
    } catch (e) {
      results.set(j.callId, { status: 'failed', text: `tool crashed: ${(e as Error).message}`, isError: true });
    }
  };
  // A writing call runs between two snapshots, so the log names every file it changed.
  const runWriting = async (j: Job) => {
    const snapshots = opts.snapshots;
    if (snapshots && !snap.tree) {
      const base = snapshots.take();
      if (base) {
        snap.tree = base;
        log.append({ kind: 'snapshot', tree: base, changed: [] });
      }
    }
    await run(j);
    if (!snapshots || !snap.tree) return;
    const after = snapshots.take();
    if (!after) return;
    log.append({ kind: 'snapshot', tree: after, callId: j.callId, changed: snapshots.diff(snap.tree, after) });
    snap.tree = after;
  };
  let pool: Job[] = [];
  for (const j of jobs) {
    if (j.parallel) pool.push(j);
    else {
      await Promise.all(pool.map(run));
      pool = [];
      await runWriting(j);
    }
  }
  await Promise.all(pool.map(run));
  // Secrets are replaced before the result is logged, so neither the log nor the provider ever holds them.
  const redact = !opts.permission?.unlock?.includes('secret-redaction');
  for (const c of calls) {
    const callId = callIdOf(c);
    const { status, ...output } = results.get(callId)!;
    const r = redact ? redactSecrets(output.text) : { text: output.text, count: 0 };
    log.append({ kind: 'tool_result', callId, status, output: r.count ? { ...output, text: r.text, redacted: r.count } : output });
  }
}
