import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyRejected, runPrompt } from '../../core/loop/run.ts';
import { preamble, BASE_SYSTEM } from '../../core/prompts.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import type { FauxStep } from '../../core/providers/faux.ts';
import { missingKeyNote } from '../../core/providers/http.ts';
import { providerFor } from '../../core/providers/index.ts';
import { projectKey, projectSlug, SessionLog, sessionExists, sessionPath } from '../../core/session/log.ts';
import { cediaHome, detectChecks, loadChecks, loadContext, loadFallback, loadHandoff, loadHandoffAt, loadPolicy, loadPrivacy, loadQuotaWait, loadRoles, loadSandbox, loadSpawn, type RoleChoice } from '../../core/config.ts';
import { defaultHandoffAt, handoffNote, MAX_HANDOFFS } from '../../core/project/handoff.ts';
import { compactedNote, compactPlan, seedCompacted } from '../../core/project/compact.ts';
import { inboxReminder, MAX_RESULT, threadsDir, ThreadStore, type SessionWhy, type Thread } from '../../core/project/threads.ts';
import { spawnNudgeAt, spawnTool, subtaskPrompt, type SpawnKind, type Spawner } from '../../core/tools/spawn.ts';
import { recallTool, threadTools, type EarlierSession } from '../../core/tools/threads.ts';
import { planPrompt, withPlan } from '../../core/roles.ts';
import { openSandbox } from '../../core/safety/sandbox.ts';
import { openSnapshots } from '../../core/safety/snapshot.ts';
import { CORE_TOOLS } from '../../core/tools/index.ts';
import type { ToolSpec } from '../../core/tools/registry.ts';
import { fixPrompt, parseVerdict, reviewPrompt, type ReviewOutcome } from '../../core/trust/review.ts';
import { addUsage, hitRatio, ZERO_USAGE, type Effort, type Spawned, type EventOf, type Evidence, type HeadlessResult, type ModelSpec, type Provider, type SessionEvent, type Step, type Timing } from '../../core/types.ts';
import { runClaudeCode } from './claude-code.ts';
import { encode } from '../../protocol/index.ts';
import { inert } from '../../core/trust/frame.ts';

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
  // Continues this thread of the project instead of opening a new one.
  thread?: string;
  // Tokens of context at which a writer session hands off to a new one, or "off".
  handoffAt?: string;
  // "note" or "compact": how it hands off.
  handoff?: string;
  // The model explore sub-threads run on, and whether writer sessions may spawn sub-threads at all.
  swarm?: string;
  spawn?: string;
  // "fallback" or "wait:<minutes>": what a spent quota does.
  onQuota?: string;
  // Reviews the change once the writer's claim passes the done gate.
  review?: string;
  checks?: string[];
  sandbox?: string;
  allowDomains?: string[];
};

// Every run that changed files or ran checks ends with a receipt built from the ledger. A check another thread ran
// (a sub-thread) is named as that thread's.
export function receipt(ev: Evidence, thread?: string): string {
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');
  const checks = ev.checks.map((c) => `${c.command} (exit ${c.exitCode}${c.thread && c.thread !== thread ? `, in sub-thread ${c.thread}` : ''})`);
  return `cedia receipt: changed ${list(ev.changed)}; checks ${list(checks)}; unverified ${list(ev.unverified)}${ev.flags?.length ? `; flagged ${ev.flags.join(', ')}` : ''}`;
}

// What a reviewer may call: everything but the tools that write files. Bash stays, under a read-only policy.
const REVIEW_TOOLS = CORE_TOOLS.filter((t) => t.effect !== 'write_workspace');

// Read-only git for a reviewer in Claude Code, in its permission-rule syntax.
const GIT_READS = ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];

const quotaSpent = (events: SessionEvent[]) => events.findLast((e) => e.kind === 'attempt')?.error?.code === 'quota';

export const continueNote = (from: ModelSpec, sessionId: string) =>
  `A session on ${from.ref} (${sessionId}) stopped partway through this task when its quota ran out. The working tree may already hold part of the work: look at what changed before you go on.`;

export const rejectedNote = (from: ModelSpec, sessionId: string) =>
  `A session on ${from.ref} (${sessionId}) stopped partway through this task when the provider refused its history, so it could not go on. The working tree may already hold part of the work: look at what changed before you go on. The recall tool searches that session's full log.`;

// A resumed thread on a model its last session did not use: the new session starts from the thread's latest
// handoff note or result, and can search the earlier logs.
export const resumeNote = (t: Thread) => {
  const last = t.sessions.at(-1)?.sessionId ?? '';
  const body = t.handoff && t.handoff.sessionId === last ? `<handoff session="${last}">\n${inert(t.handoff.note)}\n</handoff>` : t.result ? `<result session="${last}">\n${inert(t.result)}\n</result>` : '';
  return `This is thread ${t.id} of this project, picked up again in a new session. Its first task was:\n\n<task>\n${inert(t.task)}\n</task>${body ? `\n\nWhere it stopped:\n\n${body}` : ''}\n\nThe recall tool searches the thread's earlier sessions' full logs.`;
};

// One result for a run made of several sessions (quota fallback, review, fix): spend and turns add up, changed
// files and checks are pooled, and the rest is the last writer session's. A fallback session's evidence already
// counts the first session's changes; a fix session's unverified list is the one that still stands. The peak
// context is the run's own sessions' (sub-threads report theirs apart): it is what spawn and handoff keep down.
function combine(parts: HeadlessResult[], last: HeadlessResult, children: Set<HeadlessResult> = new Set()): HeadlessResult {
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
  const peakContext = Math.max(0, ...parts.filter((r) => !children.has(r)).map((r) => r.peakContext ?? 0));
  return {
    ...rest,
    ...(peakContext ? { peakContext } : {}),
    ...(timing ? { timing } : {}),
    numTurns: parts.reduce((n, r) => n + r.numTurns, 0),
    usage,
    costUsd: parts.reduce((c, r) => c + r.costUsd, 0),
    cacheHitRatio: hitRatio(usage),
    ...(evidence ? { evidence } : {}),
  };
}

export async function runHeadless(args: HeadlessArgs, out: (s: string) => void = (s) => process.stdout.write(s)): Promise<HeadlessResult> {
  const roles = loadRoles({ ...(args.model ? { code: args.model } : {}), ...(args.plan ? { plan: args.plan } : {}), ...(args.review ? { review: args.review } : {}), ...(args.swarm ? { swarm: args.swarm } : {}) });
  const spawnOn = loadSpawn(args.spawn);
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
  let quotaWaitMs: number | undefined;
  try {
    quotaWaitMs = loadQuotaWait(args.onQuota);
  } catch (e) {
    await sandbox.close();
    throw e;
  }
  for (const m of [model, ...[roles.plan, roles.review].flatMap((r) => (r?.via === 'cedia' ? [r.model] : []))]) {
    const note = missingKeyNote(m);
    if (note) process.stderr.write(note + '\n');
  }
  const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? (JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) as FauxStep[]) : undefined;
  const handoffAt = loadHandoffAt(model, args.handoffAt);
  const handoffVia = loadHandoff(args.handoff);
  // Every run belongs to a thread of the project, unless nothing is written to disk.
  const store = args.noSessionFile ? undefined : new ThreadStore(threadsDir(cediaHome(), projectKey(args.cwd)));
  if (args.thread && !store?.has(args.thread)) {
    await sandbox.close();
    throw new Error(`no thread ${args.thread} in this project${args.noSessionFile ? ' (threads need session files)' : ''}`);
  }
  const resumed = args.thread ? store!.read(args.thread) : undefined;
  const threadId = resumed?.id ?? store?.open(args.prompt);
  // Chosen once per run, so every new session of the run sees the same tools: thread tools when the project has
  // another thread to talk to.
  const others = store ? store.list().some((t) => t.id !== threadId) : false;
  const openLog = () => {
    const id = crypto.randomUUID();
    const log = SessionLog.create({ id, path: args.noSessionFile ? null : sessionPath(args.cwd, id) });
    if (args.outputFormat === 'stream-json') log.listeners.push((event) => out(encode({ type: 'event', event })));
    return log;
  };
  // The writer's sessions, the thread's earlier ones first: what recall searches.
  const earlier: EarlierSession[] = (resumed?.sessions ?? []).flatMap((s) =>
    s.role === 'code' && s.path ? [{ id: s.sessionId, events: () => (sessionExists(s.path!) ? SessionLog.load(s.path!).events : []) }] : [],
  );
  const recall = recallTool(() => earlier.filter((s) => s.id !== writer.log.id));
  const record = (log: SessionLog, m: ModelSpec, why: SessionWhy) => {
    if (store && threadId) store.append(threadId, { kind: 'session', sessionId: log.id, model: m.ref, role: 'code', why, ...(log.path ? { path: log.path } : {}) });
    if (!earlier.some((s) => s.id === log.id)) earlier.push({ id: log.id, events: () => log.events });
  };
  const reviewPreamble = preamble(args.cwd, { mode: 'read-only', sandbox, ...(context ? { context } : {}) });
  // Where each writer session of this run started in its log, for the change the run made.
  const writerRuns: { log: SessionLog; from: number }[] = [];
  // The change the run made: the first snapshot (taken before the first write) to the last, across its sessions.
  const changesPatch = (): string | undefined => {
    const snaps = writerRuns.flatMap((w) => w.log.events.slice(w.from).filter((e): e is EventOf<'snapshot'> => e.kind === 'snapshot'));
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
  // Every session of the run draws on one turn and budget allowance. Spend is metered as it happens, so a
  // sub-thread's counts against the budget of the session that spawned it, and the other way round.
  const parts: HeadlessResult[] = [];
  const meter = { usd: 0 };
  // The parts that were sub-thread sessions.
  const children = new Set<HeadlessResult>();
  const turnsSpent = () => parts.reduce((n, r) => n + r.numTurns, 0);
  let handoffs = 0;
  // Quota waits add up across the run's sessions, against the one ceiling.
  let quotaWaited = 0;
  // child: a sub-thread's session, which gets the core tools only (no spawn, threads or inbox). A work sub-thread
  // hands off like the writer, and a session it handed off to gets recall over the sub-thread's earlier sessions.
  type RunOpts = {
    continues?: { sessionId: string; changed: string[] };
    note?: string;
    role?: 'plan' | 'review' | 'explore';
    child?: { thread?: string; handoff?: boolean; recall?: ToolSpec };
    // Starts the session from another one's summary and the turns it kept (core/project/compact.ts).
    seed?: { from: SessionLog; compaction: NonNullable<HeadlessResult['compaction']> };
  };
  // What the session after a handoff starts from: the summary and kept turns, or the task and the note.
  const successor = (from: SessionLog, r: HeadlessResult): RunOpts => ({
    continues: { sessionId: from.id, changed: r.evidence?.changed ?? [] },
    ...(r.compaction ? { seed: { from, compaction: r.compaction }, note: compactedNote(from.id) } : { note: handoffNote(from.id, r.result) }),
  });
  const handingOff = (r: HeadlessResult, sub: boolean) =>
    process.stderr.write(
      `cedia: ${sub ? "a sub-thread's " : ''}context reached ${handoffAt} tokens; ${r.compaction ? 'going on in a new session from a summary of its older turns' : `handing ${sub ? 'it ' : ''}off to a new session`}\n`,
    );
  const run = async (m: ModelSpec, log: SessionLog, prompt: string, opts: RunOpts = {}) => {
    const { continues } = opts;
    const reviewer = opts.role !== undefined; // plan, review and explore read and never write
    const child = opts.child;
    const writing = !reviewer && !child; // the run's own writer: the one that hands off, gets mail and may spawn
    const usedTurns = turnsSpent();
    if (opts.seed) seedCompacted(opts.seed.from, log, opts.seed.compaction);
    // A resumed session keeps the tools it was opened with (its cached prefix); new ones get recall once the
    // thread has an earlier session, and the thread tools once the project has another thread.
    const header = log.events[0]?.kind === 'session' ? log.events[0] : undefined;
    const extra = [...(spawnOn ? [spawn] : []), ...(earlier.some((s) => s.id !== log.id) ? [recall] : []), ...(store && threadId && others ? threadTools(store, threadId) : [])];
    const tools = reviewer ? REVIEW_TOOLS : child ? [...CORE_TOOLS, ...(child.recall ? [child.recall] : [])] : header ? [...CORE_TOOLS, ...extra].filter((t) => header.tools.some((d) => d.name === t.name)) : [...CORE_TOOLS, ...extra];
    if (writing) writerRuns.push({ log, from: log.events.length });
    const result = await runPrompt(
      {
        log,
        provider: providerOf(m),
        model: m,
        // Plan and review get no write tools, and their policy is read-only whatever the run's mode.
        tools,
        system: BASE_SYSTEM,
        preamble: reviewer ? reviewPreamble : opts.note ? `${basePreamble}\n\n${opts.note}` : basePreamble,
        cwd: args.cwd,
        // They may also run the declared checks, to see what fails instead of only reading.
        permission: reviewer ? { ...policy, mode: 'read-only', allow: [...policy.allow, ...checks.map((c) => `bash(${c})`)] } : policy,
        privacy,
        checks: reviewer ? [] : checks,
        ...(softChecks && !reviewer ? { softChecks } : {}),
        ...(sandbox.on ? { wrap: sandbox.wrap } : {}),
        ...(snapshots && !reviewer ? { snapshots } : {}),
        ...(continues ? { continues } : {}),
        ...(opts.role ? { role: opts.role } : {}),
        ...(child ? (child.thread ? { thread: child.thread } : {}) : threadId ? { thread: threadId } : {}),
        ...(handoffAt !== undefined && (writing ? handoffs < MAX_HANDOFFS : child?.handoff) ? { handoffAt, ...(handoffVia === 'compact' && m.compaction ? { compact: compactPlan(handoffAt) } : {}) } : {}),
        ...(writing && spawnOn ? { spawnNudgeAt: spawnNudgeAt(handoffAt ?? defaultHandoffAt(m)) } : {}),
        ...(writing && store && threadId
          ? {
              inbox: {
                pending: () => {
                  const t = store.read(threadId);
                  return t.pending.length ? { ids: t.pending.map((p) => p.id), text: inboxReminder(t.pending) } : undefined;
                },
                delivered: (ids: string[]) => store.append(threadId, { kind: 'delivered', ids, sessionId: log.id }),
              },
            }
          : {}),
        signal: ac.signal,
        ...(quotaWaitMs !== undefined
          ? { quotaWaitMs: quotaWaitMs - quotaWaited, onQuotaWait: (ms: number) => ((quotaWaited += ms), process.stderr.write(`cedia: ${m.ref} is out of quota; waiting ${Math.ceil(ms / 60_000)} min for it to come back\n`)) }
          : {}),
        ...(args.effort ?? m.defaultEffort ? { effort: args.effort ?? m.defaultEffort } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns - usedTurns } : {}),
        ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd, meter } : {}),
        ...(args.outputFormat === 'stream-json' ? { onStream: (event) => out(encode({ type: 'stream', event })) } : {}),
      },
      prompt,
    );
    parts.push(result);
    if (child) children.add(result);
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
  let task = args.prompt;
  let writer = { model, log: undefined as unknown as SessionLog };
  // A sub-thread: its own thread (archived once it succeeds) and session, on the model its kind calls for.
  // Explore runs on the swarm model unless privacy keeps that model out; work runs on the writer's model.
  const explorer = privacy === 'zdr' && roles.swarm.dataPolicy !== 'zdr' ? model : roles.swarm;
  let subthreads = 0;
  const spawned: Spawned = { explore: 0, work: 0, handoffs: 0, peakContext: 0 };
  // An explore sub-thread whose swarm model is out of quota (Beam's free tier answers with hours to wait) goes on
  // in a new session on the writer's model, as the writer itself would. A work sub-thread whose context grows long
  // hands off to a new session of the sub-thread, as the writer does: on Haiku a sub-thread past 100k tokens would
  // pay the long-context price on every turn. Explore never hands off, since a session that only read cannot
  // (core/loop/run.ts).
  const spawner: Spawner = async (brief: string, kind: SpawnKind) => {
    subthreads++;
    spawned[kind]++;
    let m = kind === 'explore' ? explorer : writer.model;
    const sub = store?.open(brief, threadId ? { parent: threadId } : {});
    const prompt = subtaskPrompt(brief, threadId, kind);
    // The sub-thread's sessions so far: what recall searches once one has handed off.
    const mine: EarlierSession[] = [];
    const recallMine = recallTool(() => mine.slice(0, -1));
    let handoffsHere = 0;
    let cost = 0;
    const once = async (why: SessionWhy, opts: RunOpts = {}) => {
      const log = openLog();
      if (store && sub) store.append(sub, { kind: 'session', sessionId: log.id, model: m.ref, role: kind === 'explore' ? 'explore' : 'code', why, ...(log.path ? { path: log.path } : {}) });
      mine.push({ id: log.id, events: () => log.events });
      const child = { ...(sub ? { thread: sub } : {}), ...(kind === 'work' && handoffsHere < MAX_HANDOFFS ? { handoff: true } : {}), ...(mine.length > 1 ? { recall: recallMine } : {}) };
      const r = await run(m, log, prompt, { ...opts, ...(kind === 'explore' ? { role: 'explore' as const } : {}), child });
      cost += r.costUsd;
      spawned.peakContext = Math.max(spawned.peakContext, r.peakContext ?? 0);
      return { log, r };
    };
    let r: HeadlessResult;
    try {
      let last = await once('start');
      r = last.r;
      if (kind === 'explore' && m !== writer.model && r.subtype === 'error_during_execution' && quotaSpent(last.log.events)) {
        process.stderr.write(`cedia: ${m.ref} is out of quota; the explore sub-thread goes on on ${writer.model.ref}\n`);
        m = writer.model;
        r = (await once('quota')).r;
      }
      while (r.subtype === 'handoff') {
        handoffsHere++;
        spawned.handoffs++;
        const from = last.log;
        if (store && sub) store.append(sub, { kind: 'handoff', sessionId: from.id, note: r.result });
        handingOff(r, true);
        last = await once('handoff', successor(from, r));
        r = last.r;
      }
      r = { ...r, costUsd: cost };
    } catch (e) {
      if (store && sub) store.append(sub, { kind: 'state', state: 'failed', result: (e as Error).message });
      throw e;
    }
    if (store && sub) {
      store.append(sub, { kind: 'state', state: stateOf(r), result: r.result.slice(0, MAX_RESULT) });
      if (r.subtype === 'success') store.append(sub, { kind: 'archived', archived: true });
    }
    return { ...(sub ? { thread: sub } : {}), model: m.ref, subtype: r.subtype, result: r.result, costUsd: r.costUsd, changed: r.evidence?.changed ?? [], unverified: r.evidence?.unverified ?? [] };
  };
  const spawn = spawnTool(spawner);
  // Runs the writer and follows its handoffs: each note opens a new session of the thread on the same model,
  // which starts from the task (and the fix it was on, if any) and the note.
  const write = async (m: ModelSpec, log: SessionLog, prompt: string, opts: RunOpts = {}) => {
    writer = { model: m, log };
    let r = await run(m, log, prompt, opts);
    while (r.subtype === 'handoff') {
      handoffs++;
      const from = writer.log;
      if (store && threadId) store.append(threadId, { kind: 'handoff', sessionId: from.id, note: r.result });
      handingOff(r, false);
      writer = { model: m, log: openLog() };
      record(writer.log, m, 'handoff');
      const carry = prompt === task ? task : `${task}\n\n${prompt}`;
      r = await run(m, writer.log, carry, successor(from, r));
    }
    return r;
  };
  try {
    // Plan: a stronger model reads the repo and writes the plan the writer gets with the task.
    let plan: Step | undefined;
    if (roles.plan) {
      const p = await side('plan', roles.plan, planPrompt(args.prompt));
      if (p.ok && p.text.trim()) {
        task = withPlan(args.prompt, p.text.trim(), p.step.model);
        plan = p.step;
      } else process.stderr.write('cedia: going on without a plan\n');
    }
    // A resumed thread goes on in its last session when the model is the same (its cache may still be warm) and
    // the provider still takes that session's history, otherwise in a new session that starts from where the
    // thread stopped.
    const last = resumed?.sessions.findLast((s) => s.role === 'code');
    const lastLog = resumed && last?.model === model.ref && last.path && sessionExists(last.path) ? SessionLog.load(last.path) : undefined;
    let result: HeadlessResult;
    if (lastLog && !historyRejected(lastLog.events)) {
      const log = lastLog;
      if (args.outputFormat === 'stream-json') log.listeners.push((event) => out(encode({ type: 'event', event })));
      record(log, model, 'resume');
      result = await write(model, log, task);
    } else {
      const log = openLog();
      record(log, model, resumed ? 'resume' : 'start');
      result = await write(model, log, task, resumed ? { note: resumeNote(resumed) } : {});
    }
    // A spent quota does not end the task: a new session on the fallback model picks it up (a session never
    // switches model, so its cache stays valid). Nor does a history the provider refuses: a new session on the
    // same model starts from the task and the working tree. Each happens at most once a run.
    let fellBack = false;
    let restarted = false;
    while (result.subtype === 'error_during_execution') {
      const from = writer;
      const changed = result.evidence?.changed ?? [];
      const rejected = historyRejected(from.log.events);
      if (fallback && !fellBack && quotaSpent(from.log.events)) {
        fellBack = true;
        process.stderr.write(`cedia: ${from.model.ref} is out of quota; continuing on ${fallback.ref} in a new session\n`);
        const note = missingKeyNote(fallback);
        if (note) process.stderr.write(note + '\n');
        const log = openLog();
        record(log, fallback, 'quota');
        result = await write(fallback, log, task, { continues: { sessionId: from.log.id, changed }, note: continueNote(from.model, from.log.id) });
      } else if (!restarted && rejected) {
        restarted = true;
        process.stderr.write(`cedia: ${from.model.ref} refused this session's history (${rejected.code}: ${rejected.message.slice(0, 200)}); continuing in a new session\n`);
        const log = openLog();
        record(log, from.model, 'rejected');
        result = await write(from.model, log, task, { continues: { sessionId: from.log.id, changed }, note: rejectedNote(from.model, from.log.id) });
      } else break;
    }
    // Review: after the writer's claim passed the done gate, a second model reads the change. Changes it asks
    // for go back to the writer's own session once.
    let review: ReviewOutcome | undefined;
    if (roles.review && result.subtype === 'success' && result.evidence?.changed.length) {
      const r = await side('review', roles.review, reviewPrompt(args.prompt, result.evidence, changesPatch()));
      const { verdict, findings } = r.ok ? parseVerdict(r.text) : { verdict: 'unclear' as const, findings: '' };
      review = { ...r.step, verdict, fixed: false };
      if (verdict === 'changes') {
        result = await write(writer.model, writer.log, fixPrompt(r.step.model, findings));
        review.fixed = true;
      } else if (verdict === 'unclear') process.stderr.write(`cedia: the review by ${r.step.model} gave no verdict; keeping the change as it is\n`);
    }
    const sessions = [...new Set(writerRuns.map((w) => w.log.id))];
    result = { ...combine(parts, result, children), ...(plan ? { plan } : {}), ...(review ? { review } : {}), ...(threadId ? { thread: threadId } : {}), sessions, ...(subthreads ? { subthreads, spawned } : {}) };
    if (store && threadId) store.append(threadId, { kind: 'state', state: stateOf(result), result: result.result.slice(0, MAX_RESULT) });
    if (args.outputFormat === 'text') {
      out(result.result + (result.result.endsWith('\n') ? '' : '\n'));
      if (result.evidence) process.stderr.write(receipt(result.evidence, result.thread) + '\n');
      if (result.plan) process.stderr.write(`cedia plan: by ${result.plan.model}\n`);
      if (result.review) process.stderr.write(`cedia review: ${result.review.model} ${result.review.verdict === 'changes' ? 'asked for changes, sent back to the writer once' : result.review.verdict === 'approve' ? 'approved' : 'gave no verdict'}\n`);
      if (threadId) process.stderr.write(`cedia thread: ${threadId}${handoffs ? ` (${handoffs} handoff${handoffs === 1 ? '' : 's'})` : ''}; go on with --thread ${threadId}\n`);
    }
    else out(encode(result));
    return result;
  } catch (e) {
    if (store && threadId) store.append(threadId, { kind: 'state', state: 'failed', result: (e as Error).message });
    throw e;
  } finally {
    await sandbox.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

const stateOf = (r: HeadlessResult) => (r.subtype === 'success' ? 'done' : r.subtype === 'interrupted' ? 'stopped' : 'failed');
