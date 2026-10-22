import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMessages, sessionHeader } from '../context/build.ts';
import { cacheMissesOf } from '../context/cache.ts';
import { contextSize, HANDOFF_NO_TOOLS, HANDOFF_PROMPT } from '../project/handoff.ts';
import { COMPACT_INSTRUCTIONS, compactionCut, compactPlan, firstReply } from '../project/compact.ts';
import { hash } from '../hash.ts';
import { costUsd } from '../providers/catalog.ts';
import { isRetryable } from '../providers/http.ts';
import { decide, READ_ONLY_POLICY, type Policy } from '../safety/policy.ts';
import { redactSecrets } from '../safety/secrets.ts';
import type { Snapshots } from '../safety/snapshot.ts';
import type { SessionLog } from '../session/log.ts';
import { evidence, ledgerEntries, verified } from '../trust/ledger.ts';
import type { Verdict } from '../trust/classifier.ts';
import { changesFromCalls, changesFromPatch, findSlop, formatFinding, slopReminder, type SlopFinding } from '../trust/slop.ts';
import { effectOf, toolDefs, type ToolSpec } from '../tools/registry.ts';
import { spawnNudge } from '../tools/spawn.ts';
import { ASK_TOOL, questionOf } from '../tools/ask.ts';
import {
  addUsage,
  EFFORTS,
  hitRatio,
  ZERO_USAGE,
  type AssistantBlock,
  type AttemptError,
  type CompactionBlock,
  type Effort,
  type EventId,
  type EventOf,
  type HeadlessResult,
  type JsonObject,
  type ModelSpec,
  type Question,
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
  // Hand off by compaction instead of a note, on a model that takes compaction requests (core/project/compact.ts).
  // Once a turn leaves the context at startAt tokens, the provider summarizes the session up to an earlier request
  // in the background, keeping at least keepTokens of the newest context, while the session goes on. The session
  // ends with subtype 'handoff' at the first turn boundary after the summary arrives, waiting for it if the context
  // reaches handoffAt first. A compaction that brings no summary falls back to the note.
  compact?: { startAt: number; keepTokens: number };
  // Once a turn leaves the context at this many tokens, a session that has the spawn tool and has not used it is
  // reminded of it, once (core/tools/spawn.ts). Absent means never.
  spawnNudgeAt?: number;
  // Messages from other threads, shown as a reminder at each turn boundary. `delivered` runs after the reminder
  // is logged, so a crash in between shows a message twice rather than never.
  inbox?: { pending(): { ids: string[]; text: string } | undefined; delivered(ids: string[]): void };
  // The advisor role (core/trust/advisor.ts): after each turn that ran tools, it reads the turn's events and may
  // return a note, which the session logs as a reminder before its next request. Absent means no advisor.
  advise?: (turn: SessionEvent[]) => Promise<string | undefined>;
  // The classifier role (core/trust/classifier.ts): reads each command the mode alone would allow and may block
  // it. Absent means none.
  classify?: (call: { tool: string; input: JsonObject; cwd: string }) => Promise<Verdict>;
  effort?: Effort;
  // The level the session moves to, once, when the done gate refuses a claim: cheap work up front, more thought
  // where it went wrong. Only upward from `effort`, and only on models with per-message effort, so the cached
  // prefix stays.
  escalate?: Effort;
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
  // While tools run longer than this after a request was sent, its body is sent again with no output every this
  // often, so the cached prefix outlives the provider's cache lifetime (default 4 minutes, under Anthropic's 5).
  keepAliveMs?: number;
  now?: () => Date;
};

// Anthropic's default cache lifetime is 5 minutes from a request's start; a refresh within 4 keeps it. In the
// long evals every parent that waited over 5 minutes on a work sub-thread wrote its whole context to the cache
// again on its next request: at Opus 5.5's prices about $0.75 for a 150k parent, against $0.03 for a refresh.
export const KEEP_ALIVE_MS = 4 * 60_000;

// Refreshes the request's cached prefix while tools run, from `sentAt` + `every` and every `every` after, until
// stop() (which waits for one in flight, so its event lands before the next request). A provider without
// keepAlive, or every <= 0, does nothing. A failed refresh is logged and the next one is still tried.
export function keepWarm(provider: Provider, req: WireRequest, requestId: EventId, sentAt: number, every: number, log: SessionLog, signal: AbortSignal, spent: (u: Usage) => void): { stop(): Promise<void> } {
  if (!provider.keepAlive || every <= 0) return { stop: async () => {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const fire = () => {
    inFlight = (async () => {
      const start = performance.now();
      const r = await provider.keepAlive!(req, signal).catch((e: Error) => ({ ok: false as const, error: { code: 'network' as const, message: e.message } }));
      const ms = Math.round(performance.now() - start);
      if (r.ok) {
        log.append({ kind: 'keepalive', requestId, usage: r.usage, ms });
        spent(r.usage);
      } else log.append({ kind: 'keepalive', requestId, error: r.error, ms });
      if (!stopped && !signal.aborted) timer = setTimeout(fire, Math.max(0, every - ms));
    })();
  };
  timer = setTimeout(fire, Math.max(0, sentAt + every - performance.now()));
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}

export const CONTINUE_AFTER_LIMIT = 'Your previous reply was cut off by the output limit. Continue exactly where it stopped.';

// A reply with no text and no tool call (thinking only, or nothing at all) ends no task: an earlier turn's text
// would otherwise stand as the result.
export const EMPTY_REPLY = 'Your last reply had no text and no tool call. Go on with the task, or reply with what you found or did.';

// The level a session escalates to, or undefined when it cannot: no per-message effort on this model, a level the
// model lacks, or no step up from where it starts.
export function escalationTarget(model: ModelSpec, start: Effort | undefined, to: Effort | undefined): Effort | undefined {
  if (!to || !start || !model.caps.midConversationEffort || !model.caps.effortLevels.includes(to)) return undefined;
  return EFFORTS.indexOf(to) > EFFORTS.indexOf(start) ? to : undefined;
}

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
  // The compaction in flight, if any; `outcome` is set once it settles. 'off' once one failed: the note takes over.
  type Compaction = { of: EventId; ac: AbortController; settled: Promise<void>; outcome?: { block?: CompactionBlock } };
  const cmp: { now: Compaction | 'off' | undefined } = { now: opts.compact && model.compaction ? undefined : 'off' };
  const inFlight = () => (cmp.now && cmp.now !== 'off' ? cmp.now : undefined);
  let spawnNudged = false;
  // Soft checks were found, not declared: they never refuse a claim, so they never escalate either.
  const escalateTo = opts.softChecks ? undefined : escalationTarget(model, opts.effort ?? model.defaultEffort, opts.escalate);
  // Escalation: logged right after the gate's reminder, the user turn that carries it, so the change applies from
  // that turn on (core/providers/anthropic.ts). Not on a failed check: a turn of tool results alone is not new
  // input, and the note that would carry it made Haiku at low effort give up sooner (SPEC.md, effort escalation).
  const escalate = () => {
    if (escalateTo && !log.events.some((e) => e.kind === 'effort')) log.append({ kind: 'effort', effort: escalateTo });
  };
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

  const finish = (subtype: ResultSubtype, reason: TurnEndReason, result?: string, compacted?: HeadlessResult['compaction']): HeadlessResult => {
    // A compaction still in flight is no use to a session that ends: stop it, and log that here, before the end.
    const pending = inFlight();
    if (pending && !pending.outcome) {
      pending.outcome = {};
      pending.ac.abort();
      log.append({ kind: 'compaction', requestId: pending.of, stop: 'aborted', usage: { ...ZERO_USAGE }, error: { code: 'network', message: 'aborted: the session ended first' } });
    }
    log.append({ kind: 'turn_end', reason, ...(reason === 'aborted' ? { cause: 'user' as const } : {}) });
    const flags = slop().map(formatFinding);
    const ev = { ...evidence(entries()), ...(flags.length ? { flags } : {}) };
    // A run's result pools its sub-threads' evidence, so each check says which thread ran it.
    if (opts.thread) ev.checks = ev.checks.map((c) => ({ ...c, thread: opts.thread }));
    const hasEvidence = ev.changed.length > 0 || ev.checks.length > 0;
    const misses = cacheMissesOf(log.events, model, log.id, runStart);
    return {
      type: 'result',
      subtype,
      sessionId: log.id,
      numTurns: turns,
      usage,
      costUsd: cost,
      cacheHitRatio: hitRatio(usage),
      ...(misses.length ? { cacheMisses: misses } : {}),
      result: result ?? lastText,
      ...(hasEvidence ? { evidence: ev } : {}),
      timing: summarizeTiming(performance.now() - wallStart, timing, usage.output),
      ...(peakContext ? { peakContext } : {}),
      ...(compacted ? { compaction: compacted } : {}),
    };
  };

  // Asks the provider for a summary of the messages request `of` sent, without waiting for it. The compaction
  // request is logged before it is sent and its outcome when it arrives; its cost counts like a turn's.
  const startCompaction = (at: number) => {
    const of = log.events[at] as EventOf<'request'>;
    const creq: WireRequest = { ...rebuildRequest(log.events, at, model, log.id), compaction: { instructions: COMPACT_INSTRUCTIONS } };
    const sent = log.append({ kind: 'compact_request', of: of.id, bodyHash: hash(provider.body(creq)), headers: redactHeaders(provider.headers(creq)) });
    const ac = new AbortController();
    signal.addEventListener('abort', () => ac.abort(), { once: true });
    const start = performance.now();
    const c: Compaction = { of: sent.id, ac, settled: Promise.resolve() };
    c.settled = collect(provider, creq, ac.signal).then((got) => {
      if (c.outcome) return; // the session ended first
      const ms = Math.round(performance.now() - start);
      if (got.ok === true) {
        const block = got.blocks.find((b): b is CompactionBlock => b.type === 'compaction');
        log.append({ kind: 'compaction', requestId: sent.id, stop: got.stop, usage: got.usage, ...(block ? { block } : {}), ms });
        usage = addUsage(usage, got.usage);
        const c2 = costUsd(model, got.usage, now());
        cost += c2;
        if (opts.meter) opts.meter.usd += c2;
        c.outcome = block ? { block } : {};
      } else {
        const error: AttemptError = got.ok === false ? got.error : { code: 'network', message: 'aborted' };
        log.append({ kind: 'compaction', requestId: sent.id, stop: 'error', usage: { ...ZERO_USAGE }, error, ms });
        c.outcome = {};
      }
    });
    cmp.now = c;
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
    // A summary arrived: end here, at a turn boundary, so the next session keeps every turn so far after it. A
    // compaction that brought none hands the handoff back to the note.
    const settled = inFlight();
    if (settled?.outcome) {
      const { block } = settled.outcome;
      const of = (log.events.find((e) => e.id === settled.of) as EventOf<'compact_request'>).of;
      cmp.now = 'off';
      if (block) return finish('handoff', 'handoff', block.text, { block, of });
    }
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
    let sentAt = 0;
    for (let n = 1; ; n++) {
      const t: { ttftMs?: number; ms?: number } = {};
      sentAt = performance.now();
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

    const turnFrom = log.events.length;
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
      const warm = keepWarm(provider, req, request.id, sentAt, opts.keepAliveMs ?? KEEP_ALIVE_MS, log, signal, (u) => {
        usage = addUsage(usage, u);
        const c = costUsd(model, u, now());
        cost += c;
        if (opts.meter) opts.meter.usd += c;
      });
      await runTools(calls, byName, opts, signal, log, snap, shared);
      await warm.stop();
      timing.toolMs += performance.now() - toolStart;
      // A question for the owner ends the run once the turn's other calls are done; the answer is the next prompt.
      const asked = askedIn(log.events.slice(before), calls);
      if (asked) return { ...finish('asked', 'asked', asked.question), question: asked };
      // The advisor reads the turn; its note is the first thing the next request carries after the results. Its
      // time counts as model time: the run waits on a model.
      if (opts.advise && handoff === 0 && !signal.aborted) {
        const t0 = performance.now();
        const note = await opts.advise(log.events.slice(turnFrom));
        timing.modelMs += performance.now() - t0;
        if (note && !signal.aborted) log.append({ kind: 'reminder', as: 'user', text: note });
      }
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
      const first = firstReply(log.events, runStart)!;
      const changedHere = () => ledgerEntries(log.events.slice(runStart), checks, opts.cwd).some((e) => e.kind === 'write' && e.path !== undefined);
      // A session that starts from a summary starts large by design (the kept turns, and the turns that ran while the
      // summary was written: 40k to 63k on Haiku at a 90k handoff point), so doubling would carry it past the handoff
      // point; it must have grown by the share a compaction keeps instead.
      const base = contextSize(first.usage);
      const grown = log.events.some((e) => e.kind === 'summary') ? base + (opts.compact?.keepTokens ?? compactPlan(opts.handoffAt ?? 0).keepTokens) : 2 * base;
      const due = (at: number) => size >= at && size >= grown && (!opts.continues || changedHere());
      // By compaction: start it in the background, and at the handoff point wait for it to settle (the top of the
      // loop then ends the session, or falls back to the note when no summary came).
      if (cmp.now === undefined && opts.handoffAt !== undefined && handoff === 0 && due(opts.compact!.startAt)) {
        const at = compactionCut(log.events, runStart, size, opts.compact!.keepTokens);
        if (at !== undefined) startCompaction(at);
        // Nothing to summarize that would keep enough (one turn holds most of the context): the note it is.
        else if (size >= opts.handoffAt) cmp.now = 'off';
      }
      const pending = inFlight();
      if (pending && !pending.outcome && opts.handoffAt !== undefined && size >= opts.handoffAt) await pending.settled;
      // A compaction that brought no summary hands the handoff to the note, from this turn on.
      if (pending?.outcome && !pending.outcome.block) cmp.now = 'off';
      if (inFlight()) {
        // the summary is on its way, or here: the top of the loop ends the session
      } else if (cmp.now === 'off' && handoff === 0 && opts.handoffAt !== undefined && due(opts.handoffAt)) {
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
        escalate();
        continue;
      }
      if (!opts.softChecks) return finish('error_unverified_claim', 'completed');
    }
    return finish('success', 'completed');
  }
}

// The question of an ask_user call that ran and succeeded in this turn's results, if any (the first one).
function askedIn(results: SessionEvent[], calls: Extract<AssistantBlock, { type: 'tool_use' }>[]): Question | undefined {
  for (const c of calls) {
    if (c.name !== ASK_TOOL) continue;
    const r = results.find((e): e is EventOf<'tool_result'> => e.kind === 'tool_result' && e.callId === callIdOf(c));
    const q = r?.status === 'completed' && !r.output.isError ? questionOf(c.input) : undefined;
    if (q && typeof q !== 'string') return q;
  }
  return undefined;
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
      let d = decide(opts.permission ?? READ_ONLY_POLICY, spec, c.input, opts.cwd);
      // The classifier reads what the mode alone let through: a command that may write or reach out, which no
      // allow rule of the user's named.
      if (opts.classify && d.decision === 'allow' && d.rule === 'mode:workspace' && effectOf(spec, c.input) === 'exec' && !signal.aborted) {
        let v: Verdict;
        try {
          v = await opts.classify({ tool: c.name, input: c.input, cwd: opts.cwd });
        } catch (e) {
          // A guard that fails blocks; the call still gets its result.
          v = { decision: 'deny', reason: `the classifier failed (${(e as Error).message}), so nothing it has not read runs` };
        }
        // A stop while it read: the call was never decided, so it is not started rather than blocked.
        if (signal.aborted) {
          results.set(callId, { status: 'not_started', text: 'not run: the run was stopped', isError: true });
          continue;
        }
        d = v.decision === 'allow' ? { decision: 'allow', rule: 'classifier' } : { decision: 'deny', rule: 'classifier', reason: v.reason };
      }
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
  // Secrets are replaced before the result is logged, so neither the log nor the provider ever holds them.
  const redact = !opts.permission?.unlock?.includes('secret-redaction');
  const run = async (j: Job) => {
    // A stop between two calls of a reply leaves the rest unstarted rather than running them unstoppable.
    if (signal.aborted) {
      results.set(j.callId, { status: 'not_started', text: 'not run: the run was stopped', isError: true });
      return;
    }
    try {
      const spill = (text: string) => spillOutput(log.id, j.callId, redact ? redactSecrets(text).text : text);
      const out = asOutput(await j.spec.run(j.input, { cwd: opts.cwd, signal, spill, ...(opts.wrap ? { wrap: opts.wrap } : {}) }));
      results.set(j.callId, { ...out, status: signal.aborted ? 'interrupted_safe' : out.isError ? 'failed' : 'completed' });
    } catch (e) {
      results.set(j.callId, { status: 'failed', text: `tool crashed: ${e instanceof Error ? e.message : String(e)}`, isError: true });
    }
  };
  // A writing call runs between two snapshots, so the log names every file it changed.
  const runWriting = async (j: Job) => {
    // A call left unstarted by a stop changes nothing, so it needs no snapshots.
    if (signal.aborted) return run(j);
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
  for (const c of calls) {
    const callId = callIdOf(c);
    const { status, ...output } = results.get(callId)!;
    if (shared.has(callId)) output.text += `\n[cedia: more than one call in your reply shared this id; only the first ran. Call the others again if you need them.]`;
    const r = redact ? redactSecrets(output.text) : { text: output.text, count: 0 };
    log.append({ kind: 'tool_result', callId, status, output: r.count ? { ...output, text: r.text, redacted: r.count } : output });
  }
}

// A whole output too long for a result, in a file only its owner can read. Outside cedia's home, which the
// policy keeps tools out of, and in the temp dir the sandbox lets bash read, so grep and read can reach it.
// The temp dir is shared, so each directory on the way must be a real one this user owns: a symlink or another
// user's directory planted there would take the output elsewhere. Any doubt, and the result is clipped instead.
// Session directories older than a week are removed as new ones are made.
export function spillOutput(sessionId: string, callId: string, text: string, root = join(tmpdir(), `cedia-output-${process.getuid?.() ?? 'user'}`)): string | undefined {
  const ours = (dir: string) => {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && (process.getuid === undefined || st.uid === process.getuid()) && (st.mode & 0o077) === 0;
  };
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!ours(root)) return undefined;
    const dir = join(root, sessionId.replace(/[^\w.-]/g, '_'));
    if (!existsSync(dir)) {
      mkdirSync(dir, { mode: 0o700 });
      const weekAgo = Date.now() - 7 * 86_400_000;
      for (const old of readdirSync(root)) {
        const p = join(root, old);
        if (p !== dir && lstatSync(p).mtimeMs < weekAgo) rmSync(p, { recursive: true, force: true });
      }
    }
    if (!ours(dir)) return undefined;
    const path = join(dir, `${callId.replace(/[^\w.-]/g, '_')}.txt`);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
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
