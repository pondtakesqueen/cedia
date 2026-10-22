import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildMessages, sessionHeader } from '../context/build.ts';
import { contextSize, HANDOFF_NO_TOOLS, HANDOFF_PROMPT } from '../project/handoff.ts';
import { hash } from '../hash.ts';
import { costUsd } from '../providers/catalog.ts';
import { isRetryable } from '../providers/http.ts';
import { decide, READ_ONLY_POLICY, type Policy } from '../safety/policy.ts';
import { redactSecrets } from '../safety/secrets.ts';
import type { Snapshots } from '../safety/snapshot.ts';
import type { SessionLog } from '../session/log.ts';
import { evidence, ledgerEntries, verified } from '../trust/ledger.ts';
import { changesFromCalls, changesFromPatch, findSlop, formatFinding, slopReminder, type SlopFinding } from '../trust/slop.ts';
import { effectOf, toolDefs, type ToolSpec } from '../tools/registry.ts';
import { spawnNudge } from '../tools/spawn.ts';
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
  type Timing,
  type SessionEvent,
  type StopReason,
  type StreamEvent,
  type ToolOutput,
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
  // Checks cedia found in the repo rather than ones the user declared: the gate reminds once, never refuses.
  softChecks?: boolean;
  // Puts bash inside the OS sandbox; absent means unsandboxed.
  wrap?: (command: string) => Promise<string>;
  // Shadow-git snapshots around every writing call; absent means changed files come from edit/write only.
  snapshots?: Snapshots;
  role?: string;
  // Picks up from a session that stopped partway (the fallback after a spent quota). Its changed files count as
  // writes at the start of this run, so the done gate still wants a passing check after them.
  continues?: { sessionId: string; changed: string[] };
  // The thread the session belongs to (core/project/threads.ts).
  thread?: string;
  // Once a turn leaves the context at this many tokens, the session writes a handoff note and ends with subtype
  // 'handoff'; the client goes on in a new session (core/project/handoff.ts). Absent means never.
  handoffAt?: number;
  // Once a turn leaves the context at this many tokens, a session that has the spawn tool and has not used it is
  // reminded of it, once (core/tools/spawn.ts). Absent means never.
  spawnNudgeAt?: number;
  // Messages from other threads, shown as a reminder at each turn boundary. `delivered` runs after the reminder
  // is logged, so a crash in between shows a message twice rather than never.
  inbox?: { pending(): { ids: string[]; text: string } | undefined; delivered(ids: string[]): void };
  effort?: Effort;
  ttl?: '5m' | '1h';
  maxTurns?: number;
  maxBudgetUsd?: number;
  // The run's spend so far, across all its sessions, when the client keeps one: each turn adds to it, and
  // maxBudgetUsd is checked against it instead of this session's own cost. A session that spawns sub-threads
  // shares it with them, so their spend counts against the run's budget while the session is still going.
  meter?: { usd: number };
  signal?: AbortSignal;
  onStream?: (e: StreamEvent) => void;
  retry?: { max?: number; baseMs?: number; capMs?: number; sleep?: (ms: number) => Promise<void> };
  // The longest the run waits, in all, for a spent quota that says when it comes back (a 429 with retry-after);
  // absent means a spent quota ends the session at once, so the client can fall back. `onQuotaWait` hears each wait.
  quotaWaitMs?: number;
  onQuotaWait?: (ms: number) => void;
  now?: () => Date;
};

export const CONTINUE_AFTER_LIMIT = 'Your previous reply was cut off by the output limit. Continue exactly where it stopped.';

// A reply with no text and no tool call (thinking only, or nothing at all) ends no task: an earlier turn's text
// would otherwise stand as the result.
export const EMPTY_REPLY = 'Your last reply had no text and no tool call. Go on with the task, or reply with what you found or did.';

export const unverifiedReminder = (checks: string[]) =>
  `cedia has no record of a declared check passing since your last change, so the task is not done yet. A check counts only when the whole bash command is ${checks.map((c) => `\`${c}\``).join(' or ')} (a leading \`cd\` to the working directory is fine; pipes, \`;\` or other commands are not). Run it that way now, fix what fails, then report.`;

// The provider refused a request after taking this session's earlier ones: what changed is the history (a
// thinking signature it no longer accepts, a tool call it cannot read back, a context past its window), and the
// same request fails however often it is sent. The task goes on in a new session instead (clients/headless).
export function historyRejected(events: SessionEvent[]): AttemptError | undefined {
  const error = events.findLast((e): e is EventOf<'attempt'> => e.kind === 'attempt')?.error;
  if (error?.code !== 'bad_request' && error?.code !== 'context_length') return undefined;
  const request = events.findLastIndex((e) => e.kind === 'request');
  return events.slice(0, request).some((e) => e.kind === 'assistant' && e.stop !== 'aborted') ? error : undefined;
}

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

async function collect(provider: Provider, req: WireRequest, signal: AbortSignal, onStream?: (e: StreamEvent) => void, timing: { ttftMs?: number; ms?: number } = {}): Promise<Collected> {
  const start = performance.now();
  try {
    for await (const ev of provider.stream(req, signal)) {
      // Time until the provider starts streaming. Hidden thinking (Anthropic's default display) streams no text,
      // so the first visible token would count thinking as latency and leave it out of the decode rate.
      timing.ttftMs ??= Math.round(performance.now() - start);
      timing.ms = Math.round(performance.now() - start);
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

function summarizeTiming(wall: number, t: { modelMs: number; ttftMs: number; decodeMs: number; toolMs: number; retryMs: number }, outputTokens: number): Timing {
  const r = Math.round;
  return {
    wallMs: r(wall),
    modelMs: r(t.modelMs),
    ttftMs: r(t.ttftMs),
    toolMs: r(t.toolMs),
    retryMs: r(t.retryMs),
    harnessMs: Math.max(0, r(wall - t.modelMs - t.toolMs - t.retryMs)),
    outputTokPerSec: t.decodeMs > 0 ? Math.round((outputTokens / t.decodeMs) * 10_000) / 10 : 0,
  };
}

const callIdOf = (b: Extract<AssistantBlock, { type: 'tool_use' }>) => b.callId ?? b.id;

export async function runPrompt(opts: RunOptions, prompt: string): Promise<HeadlessResult> {
  const { log, provider, model, tools } = opts;
  const signal = opts.signal ?? new AbortController().signal;
  const now = opts.now ?? (() => new Date());
  // 200, not 50: on the real-repo evals Haiku finishes in 23 to 40 turns, but DeepSeek Flash takes 60 to 102
  // smaller ones and failed at 50 in 5 of 6 runs, then passed 6 of 6 at 200. The budget still caps spend.
  const maxTurns = opts.maxTurns ?? 200;
  const retryMax = opts.retry?.max ?? 5;
  // A retry wait ends early on abort, so SIGTERM (the eval's run timeout) is not held up by a long retry-after.
  const sleep = opts.retry?.sleep ?? ((ms: number) => new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  }));
  const byName = new Map(tools.map((t) => [t.name, t]));

  if (!log.events.length)
    log.append({
      kind: 'session',
      cwd: opts.cwd,
      role: opts.role ?? 'code',
      model: model.ref,
      system: opts.system,
      tools: toolDefs(tools),
      ...(opts.continues ? { parentSession: opts.continues.sessionId } : {}),
      ...(opts.thread ? { thread: opts.thread } : {}),
    });
  const header = sessionHeader(log.events);

  let usage: Usage = { ...ZERO_USAGE };
  let cost = 0;
  let turns = 0;
  let lastText = '';

  const checks = opts.checks ?? [];
  let runStart = log.events.length;
  // Inherited writes sit at 0, the user prompt's slot, so any check in this run comes after them.
  const inherited = (opts.continues?.changed ?? []).map((path) => ({ kind: 'write' as const, at: 0, tool: 'parent', path }));
  const entries = () => [...inherited, ...ledgerEntries(log.events.slice(runStart), checks, opts.cwd)];
  let nudged = false;
  let emptyNudged = false;
  const snap: { tree?: string } = {};
  // 0: working; 1: asked for the note; 2: asked again after a tool call; 'off': gave up on handing off.
  let handoff: 0 | 1 | 2 | 'off' = 0;
  let spawnNudged = false;
  const wallStart = performance.now();
  const timing = { modelMs: 0, ttftMs: 0, decodeMs: 0, toolMs: 0, retryMs: 0 };
  // The largest context any reply of this run saw: what handoff and sub-threads are meant to keep down.
  let peakContext = 0;
  let quotaWaited = 0;

  // The slop guard reads this run's changes: the patch between its first and latest snapshot, or the edit and
  // write calls when snapshots are off.
  const slopOn = !opts.permission?.unlock?.includes('slop-check');
  let slopNudged = false;
  const slop = (): SlopFinding[] => {
    if (!slopOn) return [];
    const run = log.events.slice(runStart);
    const base = run.find((e): e is EventOf<'snapshot'> => e.kind === 'snapshot');
    try {
      if (opts.snapshots && base && snap.tree) return findSlop(changesFromPatch(opts.snapshots.patch(base.tree, snap.tree)));
    } catch {
      // fall back to the calls
    }
    return findSlop(changesFromCalls(run));
  };

  const finish = (subtype: ResultSubtype, reason: TurnEndReason, result?: string): HeadlessResult => {
    log.append({ kind: 'turn_end', reason, ...(reason === 'aborted' ? { cause: 'user' as const } : {}) });
    const flags = slop().map(formatFinding);
    const ev = { ...evidence(entries()), ...(flags.length ? { flags } : {}) };
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
      timing: summarizeTiming(performance.now() - wallStart, timing, usage.output),
      ...(peakContext ? { peakContext } : {}),
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
    const mail = handoff === 0 ? opts.inbox?.pending() : undefined;
    if (mail) {
      log.append({ kind: 'reminder', as: 'user', text: mail.text });
      opts.inbox!.delivered(mail.ids);
    }

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
      const t: { ttftMs?: number; ms?: number } = {};
      got = await collect(provider, req, signal, opts.onStream, t);
      if (got.ok === 'aborted') {
        log.append({ kind: 'attempt', requestId: request.id, n, error: { code: 'network', message: 'aborted' } });
        log.append({ kind: 'assistant', wire: provider.wire, model: model.ref, blocks: [], stop: 'aborted', usage: { ...ZERO_USAGE } });
        return finish('interrupted', 'aborted');
      }
      if (got.ok) {
        log.append({ kind: 'attempt', requestId: request.id, n, ...t });
        timing.modelMs += t.ms ?? 0;
        timing.ttftMs += t.ttftMs ?? 0;
        timing.decodeMs += (t.ms ?? 0) - (t.ttftMs ?? 0);
        break;
      }
      log.append({ kind: 'attempt', requestId: request.id, n, error: got.error, ...t });
      timing.modelMs += t.ms ?? 0;
      const after = got.error.retryAfterMs;
      const quotaWait = got.error.code === 'quota' && opts.quotaWaitMs !== undefined && after !== undefined && quotaWaited + after <= opts.quotaWaitMs ? after : undefined;
      if ((!isRetryable(got.error) && quotaWait === undefined) || n >= retryMax) return finish('error_during_execution', 'error', got.error.message);
      const base = opts.retry?.baseMs ?? 1000;
      const cap = opts.retry?.capMs ?? 30_000;
      const wait = after ?? Math.min(cap, base * 2 ** (n - 1));
      if (quotaWait !== undefined) {
        quotaWaited += quotaWait;
        opts.onQuotaWait?.(quotaWait);
      }
      await sleep(wait);
      timing.retryMs += wait;
      if (signal.aborted) return finish('interrupted', 'aborted');
    }
    if (!got.ok) throw new Error('unreachable');

    log.append({ kind: 'assistant', wire: provider.wire, model: model.ref, blocks: got.blocks, stop: got.stop, usage: got.usage });
    usage = addUsage(usage, got.usage);
    peakContext = Math.max(peakContext, contextSize(got.usage));
    const turnCost = costUsd(model, got.usage, now());
    cost += turnCost;
    if (opts.meter) opts.meter.usd += turnCost;
    const text = got.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (text) lastText = text;

    const all = got.blocks.filter((b): b is Extract<AssistantBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    // A call that repeats an earlier call's id is not run: the wire pairs results by id, so only one can answer.
    const calls = all.filter((c, i) => all.findIndex((d) => callIdOf(d) === callIdOf(c)) === i);
    const shared = new Set(all.filter((c) => !calls.includes(c)).map(callIdOf));
    if (calls.length || text.trim()) emptyNudged = false;
    const overBudget = opts.maxBudgetUsd !== undefined && (opts.meter?.usd ?? cost) >= opts.maxBudgetUsd;

    if (handoff === 1 || handoff === 2) {
      if (!calls.length && text.trim()) return finish('handoff', 'handoff', text.trim());
      for (const c of calls) log.append({ kind: 'tool_result', callId: callIdOf(c), status: 'not_started', output: { text: HANDOFF_NO_TOOLS, isError: true } });
      if (handoff === 1 && !overBudget) {
        handoff = 2;
        continue;
      }
      // No note: this session goes on with its own context.
      handoff = 'off';
      if (calls.length) continue;
    }
    if (calls.length) {
      if (overBudget || signal.aborted) {
        for (const c of calls)
          log.append({ kind: 'tool_result', callId: callIdOf(c), status: 'not_started', output: { text: 'not run: the session stopped', isError: true } });
        return overBudget ? finish('error_max_budget_usd', 'budget') : finish('interrupted', 'aborted');
      }
      const toolStart = performance.now();
      const before = log.events.length;
      await runTools(calls, byName, opts, signal, log, snap, shared);
      timing.toolMs += performance.now() - toolStart;
      // Hand off at a turn boundary, while the whole prefix is still cached: the note costs one cheap turn.
      // The size is the last reply's usage plus chars/4 for the results just added. The context must also have
      // doubled since the session's first reply, so a session that starts large (a long note, a big task) does
      // not hand off again straight away. A session that picked up from another must have changed a file itself
      // before it hands off: a note cannot carry what was read, so a chain of sessions that only read would each
      // read it all again (in the repo evals, five in a row on one run, before notes carried the plan). The first
      // session may hand off having only read, with a plan and the line ranges to read: on Haiku it otherwise
      // read on past 100k, where every turn costs the long-context price, and handed off after its first edit
      // anyway, at 125k to 145k (evals/results/README.md, long tasks).
      const added = log.events.slice(before).reduce((n, e) => n + (e.kind === 'tool_result' ? Math.ceil(e.output.text.length / 4) : 0), 0);
      const size = contextSize(got.usage) + added;
      const first = log.events.find((e): e is EventOf<'assistant'> => e.kind === 'assistant')!;
      const changedHere = () => ledgerEntries(log.events.slice(runStart), checks, opts.cwd).some((e) => e.kind === 'write' && e.path !== undefined);
      if (handoff === 0 && opts.handoffAt !== undefined && size >= opts.handoffAt && size >= 2 * contextSize(first.usage) && (!opts.continues || changedHere())) {
        handoff = 1;
        log.append({ kind: 'reminder', as: 'user', text: HANDOFF_PROMPT });
      } else if (!spawnNudged && handoff === 0 && opts.spawnNudgeAt !== undefined && size >= opts.spawnNudgeAt && byName.has('spawn')) {
        spawnNudged = true;
        if (!log.events.some((e) => e.kind === 'tool_intent' && e.tool === 'spawn')) log.append({ kind: 'reminder', as: 'user', text: spawnNudge(size) });
      }
      continue;
    }
    if (overBudget) return finish('error_max_budget_usd', 'budget');
    if (got.stop === 'max_tokens') {
      log.append({ kind: 'reminder', as: 'user', text: CONTINUE_AFTER_LIMIT });
      continue;
    }
    // A refusal ends the run as a failure, whatever the ledger holds.
    if (got.stop === 'refusal') return finish('error_during_execution', 'error', text || `${model.ref} declined to go on with this task`);
    if (!text.trim()) {
      if (emptyNudged) return finish('error_during_execution', 'error', `${model.ref} ended its turn twice without a reply`);
      emptyNudged = true;
      log.append({ kind: 'reminder', as: 'user', text: EMPTY_REPLY });
      continue;
    }
    // Slop guard: one reminder naming what looks like a shortcut; the model fixes it or explains it.
    if (!slopNudged) {
      const found = slop();
      if (found.length) {
        slopNudged = true;
        log.append({ kind: 'reminder', as: 'user', text: slopReminder(found) });
        continue;
      }
    }
    // Done gate: one reminder to run a declared check, then the claim is refused.
    if (!verified(entries(), checks)) {
      if (!nudged) {
        nudged = true;
        log.append({ kind: 'reminder', as: 'user', text: unverifiedReminder(checks) });
        continue;
      }
      if (!opts.softChecks) return finish('error_unverified_claim', 'completed');
    }
    return finish('success', 'completed');
  }
}

// A guard's denial is final; a command cedia could not read can be rewritten, since nothing was refused.
function deniedText(rule: string, reason: string): string {
  if (rule.startsWith('shell:'))
    return `not run: cedia could not read this command (${reason}). Rewrite it: put file contents in the write tool instead of a shell string, or simplify the quoting.`;
  return `denied (${rule}): ${reason}. Do not retry it another way; go on with the rest of the task and tell the user what you needed.`;
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
  shared: Set<string>,
) {
  type Job = { callId: string; spec: ToolSpec; input: Record<string, unknown>; parallel: boolean };
  const results = new Map<string, EventOf<'tool_result'>['output'] & { status: EventOf<'tool_result'>['status'] }>();
  const jobs: Job[] = [];
  for (const c of calls) {
    const callId = callIdOf(c);
    const spec = byName.get(c.name);
    if (c.inputError) results.set(callId, { status: 'not_started', text: `not run: ${c.inputError}`, isError: true });
    else if (!spec) results.set(callId, { status: 'not_started', text: `not run: unknown tool "${c.name.length > 64 ? `${c.name.slice(0, 64)}…` : c.name}"`, isError: true });
    else {
      const d = decide(opts.permission ?? READ_ONLY_POLICY, spec, c.input, opts.cwd);
      log.append({ kind: 'permission', callId, tool: c.name, ...d });
      if (d.decision === 'deny') {
        results.set(callId, { status: 'denied', text: deniedText(d.rule, d.reason ?? ''), isError: true });
        continue;
      }
      log.append({ kind: 'tool_intent', callId, tool: c.name, input: c.input });
      const effect = effectOf(spec, c.input);
      jobs.push({ callId, spec, input: c.input, parallel: effect === 'read' || effect === 'network' });
    }
  }
  const run = async (j: Job) => {
    try {
      const out = asOutput(await j.spec.run(j.input, { cwd: opts.cwd, signal, ...(opts.wrap ? { wrap: opts.wrap } : {}) }));
      results.set(j.callId, { ...out, status: signal.aborted ? 'interrupted_safe' : out.isError ? 'failed' : 'completed' });
    } catch (e) {
      results.set(j.callId, { status: 'failed', text: `tool crashed: ${e instanceof Error ? e.message : String(e)}`, isError: true });
    }
  };
  // A writing call runs between two snapshots, so the log names every file it changed.
  const runWriting = async (j: Job) => {
    const snapshots = opts.snapshots;
    if (snapshots && !snap.tree) {
      const t0 = performance.now();
      const base = snapshots.take();
      if (base) {
        snap.tree = base;
        log.append({ kind: 'snapshot', tree: base, changed: [], ms: Math.round(performance.now() - t0) });
      }
    }
    await run(j);
    if (!snapshots || !snap.tree) return;
    const t1 = performance.now();
    const after = snapshots.take();
    if (!after) return;
    log.append({ kind: 'snapshot', tree: after, callId: j.callId, changed: snapshots.diff(snap.tree, after), ms: Math.round(performance.now() - t1) });
    snap.tree = after;
  };
  let pool: Job[] = [];
  for (const j of jobs) {
    if (j.parallel) pool.push(j);
    else {
      await bounded(pool, MAX_PARALLEL_TOOLS, run);
      pool = [];
      await runWriting(j);
    }
  }
  await bounded(pool, MAX_PARALLEL_TOOLS, run);
  // Secrets are replaced before the result is logged, so neither the log nor the provider ever holds them.
  const redact = !opts.permission?.unlock?.includes('secret-redaction');
  for (const c of calls) {
    const callId = callIdOf(c);
    const { status, ...output } = results.get(callId)!;
    if (shared.has(callId)) output.text += `\n[cedia: more than one call in your reply shared this id; only the first ran. Call the others again if you need them.]`;
    const r = redact ? redactSecrets(output.text) : { text: output.text, count: 0 };
    log.append({ kind: 'tool_result', callId, status, output: r.count ? { ...output, text: r.text, redacted: r.count } : output });
  }
}

// What a tool hands back, as the wire needs it: a tool that returns nothing or an object for text (an MCP tool,
// say) still gets a string result, so the next request is not refused.
function asOutput(out: unknown): ToolOutput {
  if (!out || typeof out !== 'object') return { text: 'tool returned no output', isError: true };
  const o = out as Partial<ToolOutput> & { text?: unknown };
  const text = typeof o.text === 'string' ? o.text : o.text === undefined || o.text === null ? '(no output)' : (JSON.stringify(o.text) ?? String(o.text));
  return { ...o, text, isError: o.isError === true };
}

// Read-only calls of one turn run together, at most this many at a time.
export const MAX_PARALLEL_TOOLS = 8;

// Runs `fn` over `items` with at most `limit` in flight, starting them in order.
export async function bounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
