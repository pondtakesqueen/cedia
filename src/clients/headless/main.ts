import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyRejected, runPrompt } from '../../core/loop/run.ts';
import { modeNote, preamble, BASE_SYSTEM } from '../../core/prompts.ts';
import { resolveModel } from '../../core/providers/catalog.ts';
import type { FauxStep } from '../../core/providers/faux.ts';
import { missingKeyNote } from '../../core/providers/http.ts';
import { providerFor } from '../../core/providers/index.ts';
import { projectKey, projectSlug, SessionLog, sessionExists, sessionPath } from '../../core/session/log.ts';
import { cediaHome, detectChecks, loadChecks, loadContext, loadFallback, loadHandoff, loadHandoffAt, loadHooks, loadMcp, loadPolicy, loadPrivacy, loadQuotaWait, loadRoles, loadSandbox, loadSpawn, loadAsk, loadTodo, loadProfiles, loadLsp, type RoleChoice } from '../../core/config.ts';
import { defaultHandoffAt, handoffNote, MAX_HANDOFFS, resumeChoice } from '../../core/project/handoff.ts';
import { compactedNote, compactPlan, seedCompacted } from '../../core/project/compact.ts';
import { instructionsBlock, loadInstructions } from '../../core/project/instructions.ts';
import { memoryBlock, memoryPath, MemoryStore, rememberTool } from '../../core/project/memory.ts';
import { loadSkills, skillCommand, skillsBlock, skillTool } from '../../core/skills/skills.ts';
import { mcpStub, startMcp, type McpServers } from '../../core/mcp/tools.ts';
import { webFetchTool } from '../../core/tools/web.ts';
import { runTurn } from '../../core/project/undo.ts';
import { inboxReminder, MAX_RESULT, threadsDir, ThreadStore, type SessionWhy, type Thread } from '../../core/project/threads.ts';
import { spawnNudgeAt, spawnPool, spawnReport, spawnTool, subtaskPrompt, type SpawnKind, type SpawnOutcome, type Spawner } from '../../core/tools/spawn.ts';
import { recallTool, threadTools, type EarlierSession } from '../../core/tools/threads.ts';
import { answerPrompt, askTool } from '../../core/tools/ask.ts';
import { todoTool } from '../../core/tools/todo.ts';
import { BROWSER_TOOL, browserStub, browserTool } from '../../core/tools/browser.ts';
import { openThreadTool } from '../../core/tools/open.ts';
import { scheduleTool } from '../../core/tools/schedule.ts';
import { ScheduleStore, schedulesPath } from '../../core/project/schedules.ts';
import { resolveProfile, withProfile } from '../../core/profiles.ts';
import { planParts, planPrompt, withParts, withPlan, type Part, type Split } from '../../core/roles.ts';
import { openSandbox } from '../../core/safety/sandbox.ts';
import { lspServers, openDiagnoser } from '../../core/lsp/diagnose.ts';
import { bashTool, scrubbedEnv } from '../../core/tools/bash.ts';
import { workspaceSnapshots } from '../../core/safety/snapshot.ts';
import { applyWorktree, openWorktree, type Worktree } from '../../core/project/worktree.ts';
import { approachBrief, bestTry, type Try } from '../../core/project/bestof.ts';
import { decide, type RunPermission } from '../../core/safety/policy.ts';
import { editTool } from '../../core/tools/edit.ts';
import { sandboxGuarded } from '../../core/safety/sandbox.ts';
import type { Snapshots } from '../../core/safety/snapshot.ts';
import { CORE_TOOLS } from '../../core/tools/index.ts';
import { toolDefs, type ToolSpec } from '../../core/tools/registry.ts';
import { ADVISOR_SYSTEM, adviceOf, advicePrompt, adviceReminder, turnDigest } from '../../core/trust/advisor.ts';
import { callText, CLASSIFIER_SYSTEM, classifyPrompt, MAX_INPUT, namedFiles, verdictOf, type Verdict } from '../../core/trust/classifier.ts';
import { fixPrompt, parseVerdict, reviewPrompt, type ReviewOutcome } from '../../core/trust/review.ts';
import { goalContinuePrompt, goalPrompt, MAX_GOAL_ROUNDS, parseGoal, type GoalRound } from '../../core/trust/goal.ts';
import { addUsage, hitRatio, ZERO_USAGE, type Effort, type JsonObject, type Spawned, type EventOf, type Evidence, type HeadlessResult, type ModelSpec, type Provider, type SessionEvent, type Step, type Timing } from '../../core/types.ts';
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
  // The level a writer session moves to when the done gate refuses its claim, or "off". Default high.
  escalate?: string;
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
  // Models besides the code model that a part of a split plan may run on (comma-separated refs).
  workers?: string;
  spawn?: string;
  // Language servers for diagnostics after edits: on (the default) or off.
  lsp?: string;
  // "on" gives the writer ask_user, to end the run with a question for the owner (core/tools/ask.ts).
  ask?: string;
  // "on" gives the writer the todo tool, whose list a client draws as the thread's progress (core/tools/todo.ts).
  todo?: string;
  // A Chromium's DevTools endpoint (core/tools/browser.ts): the writer gets the browser tool on its page. "off" or
  // none: no browser.
  browser?: string;
  // A named set of defaults under the flags (core/profiles.ts); a thread goes on with the profile it was opened with.
  profile?: string;
  // "fallback" or "wait:<minutes>": what a spent quota does.
  onQuota?: string;
  // Reviews the change once the writer's claim passes the done gate.
  review?: string;
  // Reads each of the writer's turns and may leave a note before the next.
  advisor?: string;
  classifier?: string;
  checks?: string[];
  sandbox?: string;
  allowDomains?: string[];
  // For a client that owns the terminal (the TUI): where cedia's own notes go instead of stderr, and a stop.
  note?: (text: string) => void;
  signal?: AbortSignal;
  // Keep going until a separate judge finds this condition holds (core/trust/goal.ts), judged by goalJudge (a
  // model ref; default the writer's model, in a fresh read-only session).
  goal?: string;
  goalJudge?: string;
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
// The advisor's sessions (advised) count in spend and usage, but not in turns or time: its turns are not the run's
// (--max-turns counts the writer's), and the writer's own time already holds every wait on it.
function combine(parts: HeadlessResult[], last: HeadlessResult, children: Set<HeadlessResult> = new Set(), advised: Set<HeadlessResult> = new Set()): HeadlessResult {
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
  const timed = parts.flatMap((r) => (r.timing && !advised.has(r) ? [{ t: r.timing, out: r.usage.output }] : []));
  const sum = (k: Exclude<keyof Timing, 'outputTokPerSec'>) => timed.reduce((n, x) => n + x.t[k], 0);
  const decodeSec = timed.reduce((n, x) => n + (x.t.outputTokPerSec > 0 ? x.out / x.t.outputTokPerSec : 0), 0);
  const decoded = timed.reduce((n, x) => n + (x.t.outputTokPerSec > 0 ? x.out : 0), 0);
  const timing: Timing | undefined = timed.length
    ? { wallMs: sum('wallMs'), modelMs: sum('modelMs'), ttftMs: sum('ttftMs'), toolMs: sum('toolMs'), retryMs: sum('retryMs'), harnessMs: sum('harnessMs'), outputTokPerSec: decodeSec > 0 ? Math.round((decoded / decodeSec) * 10) / 10 : 0 }
    : undefined;
  const { evidence: _, timing: __, ...rest } = last;
  const peakContext = Math.max(0, ...parts.filter((r) => !children.has(r)).map((r) => r.peakContext ?? 0));
  const inputRepairs: Record<string, number> = {};
  for (const r of parts) for (const [k, v] of Object.entries(r.inputRepairs ?? {})) inputRepairs[k] = (inputRepairs[k] ?? 0) + v;
  const cacheMisses = parts.flatMap((r) => r.cacheMisses ?? []);
  return {
    ...rest,
    ...(peakContext ? { peakContext } : {}),
    ...(timing ? { timing } : {}),
    numTurns: parts.reduce((n, r) => n + (advised.has(r) ? 0 : r.numTurns), 0),
    usage,
    costUsd: parts.reduce((c, r) => c + r.costUsd, 0),
    cacheHitRatio: hitRatio(usage),
    ...(Object.keys(inputRepairs).length ? { inputRepairs } : {}),
    ...(cacheMisses.length ? { cacheMisses } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export async function runHeadless(given: HeadlessArgs, out: (s: string) => void = (s) => process.stdout.write(s)): Promise<HeadlessResult> {
  // The profile named, else the one the thread was opened with; its defaults go under the flags.
  const recorded = () => {
    const st = new ThreadStore(threadsDir(cediaHome(), projectKey(given.cwd)));
    return given.thread && st.has(given.thread) ? st.read(given.thread).profile : undefined;
  };
  const profileName = given.profile ?? (given.thread && !given.noSessionFile ? recorded() : undefined);
  const profile = profileName ? { name: profileName, ...resolveProfile(profileName, loadProfiles()) } : undefined;
  const args = profile ? withProfile(given, profile) : given;
  const say = args.note ?? ((text: string) => void process.stderr.write(text));
  const roles = loadRoles({ ...(args.model ? { code: args.model } : {}), ...(args.plan ? { plan: args.plan } : {}), ...(args.review ? { review: args.review } : {}), ...(args.swarm ? { swarm: args.swarm } : {}), ...(args.advisor ? { advisor: args.advisor } : {}), ...(args.classifier ? { classifier: args.classifier } : {}), ...(args.workers ? { workers: args.workers } : {}) });
  const spawnMode = loadSpawn(args.spawn);
  const spawnOn = spawnMode !== 'off';
  const lspSetting = loadLsp(args.lsp);
  const askOn = loadAsk(args.ask);
  const todoOn = loadTodo(args.todo);
  const model = roles.code;
  const declared = loadChecks(args.cwd, args.checks);
  const checks = declared.length ? declared : detectChecks(args.cwd);
  const softChecks = !declared.length && checks.length > 0;
  const privacy = loadPrivacy(args.cwd, args.privacy);
  const context = loadContext();
  const sandboxSettings = loadSandbox({ ...(args.sandbox ? { mode: args.sandbox } : {}), allowDomains: args.allowDomains ?? [] });
  const { sandbox, note: sandboxNote } = await openSandbox(args.cwd, sandboxSettings.mode, { allowedDomains: sandboxSettings.allowedDomains, cediaHome: cediaHome() });
  if (sandboxNote) say(sandboxNote + '\n');
  const policyFlags = { ...(args.permission ? { mode: args.permission } : {}), allow: args.allow ?? [], deny: args.deny ?? [], unlock: args.unlock ?? [] };
  let policy;
  try {
    policy = loadPolicy(args.cwd, policyFlags, process.env, sandbox.on);
  } catch (e) {
    await sandbox.close();
    throw e;
  }
  if (!sandbox.on && policy.mode === 'read-only' && !args.permission && !process.env.CEDIA_PERMISSION)
    say('cedia: the sandbox is off, so this session is read-only. Use --permission workspace to allow writes without it.\n');
  const permission: RunPermission = policy.plan ? 'plan' : policy.mode;
  const snapshots = workspaceSnapshots(args.cwd, cediaHome(), sandbox.placeholders);
  // Language servers start at the first edit they cover, run as bash does (when the policy lets bash run them), and
  // stop with the run.
  const servers = lspServers(args.cwd, lspSetting);
  const lspPolicy = policy;
  const diagnoser = servers.length
    ? openDiagnoser(args.cwd, servers, {
        ...(sandbox.on ? { wrap: sandbox.wrap } : {}),
        env: scrubbedEnv(),
        warn: (l) => say(`${l}\n`),
        may: (line) => decide(lspPolicy, bashTool, { command: line }, args.cwd).decision === 'allow',
      })
    : undefined;
  const fallback = loadFallback(model, args.fallback);
  const hooks = loadHooks();
  const hooked = Object.values(hooks).some((l) => l?.length);
  let quotaWaitMs: number | undefined;
  try {
    quotaWaitMs = loadQuotaWait(args.onQuota);
  } catch (e) {
    await sandbox.close();
    throw e;
  }
  for (const m of [model, ...[roles.plan, roles.review].flatMap((r) => (r?.via === 'cedia' ? [r.model] : [])), ...(roles.advisor ? [roles.advisor] : []), ...(roles.classifier ? [roles.classifier] : [])]) {
    const note = missingKeyNote(m);
    if (note) say(note + '\n');
  }
  const fauxScript = process.env.CEDIA_FAUX_SCRIPT ? (JSON.parse(readFileSync(process.env.CEDIA_FAUX_SCRIPT, 'utf8')) as FauxStep[]) : undefined;
  let handoffAt: ReturnType<typeof loadHandoffAt>;
  let goalJudge: typeof model | undefined;
  try {
    handoffAt = loadHandoffAt(model, args.handoffAt);
    goalJudge = args.goal ? (args.goalJudge ? resolveModel(args.goalJudge) : model) : undefined;
  } catch (e) {
    await sandbox.close();
    throw e;
  }
  if (goalJudge && goalJudge !== model) {
    const note = missingKeyNote(goalJudge);
    if (note) say(note + '\n');
  }
  const handoffVia = loadHandoff(args.handoff);
  const escalate = args.escalate === 'off' ? undefined : ((args.escalate ?? 'high') as Effort);
  // Every run belongs to a thread of the project, unless nothing is written to disk.
  const store = args.noSessionFile ? undefined : new ThreadStore(threadsDir(cediaHome(), projectKey(args.cwd)));
  if (args.thread && !store?.has(args.thread)) {
    await sandbox.close();
    throw new Error(`no thread ${args.thread} in this project${args.noSessionFile ? ' (threads need session files)' : ''}`);
  }
  const resumed = args.thread ? store!.read(args.thread) : undefined;
  const threadId = resumed?.id ?? store?.open(args.prompt, profile ? { profile: profile.name } : {});
  // This run's id: every thread event it writes carries it, so a rewind past the run drops them even when they are
  // written after it (core/project/rewind.ts).
  const runId = `r-${crypto.randomUUID().slice(0, 8)}`;
  // Chosen once per run, so every new session of the run sees the same tools: thread tools when the project has
  // another thread to talk to.
  // A profile that opens threads gets the thread tools from the start, to follow the ones it opens.
  const others = store ? !!profile?.openThread || store.list().some((t) => t.id !== threadId) : false;
  const opened = { count: 0 };
  const openLog = () => {
    const id = crypto.randomUUID();
    const log = SessionLog.create({ id, path: args.noSessionFile ? null : sessionPath(args.cwd, id) });
    if (args.outputFormat === 'stream-json') log.listeners.push((event) => out(encode({ type: 'event', event })));
    return log;
  };
  // The writer's sessions, the thread's earlier ones first: what recall searches.
  // A session a rewind left behind is not searched: the user took that work back.
  const earlier: EarlierSession[] = (resumed?.sessions ?? []).flatMap((s) =>
    s.role === 'code' && s.path && !resumed!.rewound.includes(s.sessionId) ? [{ id: s.sessionId, events: () => (sessionExists(s.path!) ? SessionLog.load(s.path!).events : []) }] : [],
  );
  const recall = recallTool(() => earlier.filter((s) => s.id !== writer.log.id));
  const record = (log: SessionLog, m: ModelSpec, why: SessionWhy) => {
    if (store && threadId) store.append(threadId, { run: runId, kind: 'session', sessionId: log.id, model: m.ref, role: 'code', why, ...(log.path ? { path: log.path } : {}) });
    if (!earlier.some((s) => s.id === log.id)) earlier.push({ id: log.id, events: () => log.events });
  };
  const instructions = instructionsBlock(loadInstructions(args.cwd));
  // Project memory: read by every session, kept by the writer (not when nothing is written to disk).
  const memory = new MemoryStore(memoryPath(cediaHome(), projectKey(args.cwd)));
  const remembered = (() => {
    try {
      return memoryBlock(memory.notes());
    } catch (e) {
      say(`cedia: could not read the project's memory (${(e as Error).message}); going on without it\n`);
      return '';
    }
  })();
  const remember = store ? rememberTool(memory, threadId ?? 'cedia') : undefined;
  const skills = loadSkills(args.cwd, cediaHome());
  const skillList = skillsBlock(skills);
  const skill = skillTool(skills);
  // The hosts the shell may reach, so a fetch is no way around the sandbox.
  // web_fetch reaches what the session's shell may reach (core/tools/web.ts): the named domains, plus any public
  // host when the sandbox is off and the session may run commands. Allow rules widen it: `web_fetch` for any host,
  // `web_fetch(<domain>)` for one.
  const fetchRules = policy.allow.flatMap((r) => {
    const m = /^web_fetch(?:\((.*)\))?$/.exec(r.trim());
    return m ? [m[1]?.trim() || '*'] : [];
  });
  // A bare rule opens public hosts only; a private address still needs its host named.
  const webAccess = (mode: 'read-only' | 'workspace') => ({ anyHost: (!sandbox.on && mode === 'workspace') || fetchRules.includes('*'), allowedDomains: [...sandboxSettings.allowedDomains, ...fetchRules.filter((d) => d !== '*')] });
  const webFetch = webFetchTool(webAccess(policy.mode));
  const webFetchRead = webFetchTool(webAccess('read-only'));
  // The browser opens what web_fetch reaches, widened by its own rules (`browser`, `browser(<domain>)`), plus the
  // local preview (core/tools/browser.ts).
  const browserRules = policy.allow.flatMap((r) => {
    const m = /^browser(?:\((.*)\))?$/.exec(r.trim());
    return m ? [m[1]?.trim() || '*'] : [];
  });
  const browserAccess = { anyHost: webAccess(policy.mode).anyHost || browserRules.includes('*'), allowedDomains: [...webAccess(policy.mode).allowedDomains, ...browserRules.filter((d) => d !== '*')] };
  const browser = args.browser && args.browser !== 'off' ? browserTool(args.browser, browserAccess) : undefined;
  // Started inside the run's try below, so they are closed however it ends.
  let mcp: McpServers | undefined;
  const reviewPreamble = preamble(args.cwd, { mode: 'read-only', sandbox, ...(context ? { context } : {}), ...(instructions ? { instructions } : {}), ...(remembered ? { memory: remembered } : {}), ...(skillList ? { skills: skillList } : {}) });
  // Where each writer session of this run started in its log, for the change the run made.
  const writerRuns: { log: SessionLog; from: number }[] = [];
  // The change the run made: the first snapshot (taken before the first write) to the last, across its sessions.
  const turnTrees = () => runTurn(writerRuns.map((w) => ({ events: w.log.events, from: w.from })));
  const changesPatch = (): string | undefined => {
    const trees = turnTrees();
    if (!snapshots || !trees) return undefined;
    try {
      return snapshots.patch(trees.before, trees.after);
    } catch {
      return undefined;
    }
  };
  // What /undo and /diff take as this run's turn (core/project/undo.ts), however the run ended.
  const recordTurn = () => {
    const trees = turnTrees();
    if (store && threadId && trees) store.append(threadId, { run: runId, kind: 'turn', cwd: args.cwd, ...trees, sessions: [...new Set(writerRuns.map((w) => w.log.id))] });
  };
  const basePreamble = preamble(args.cwd, { mode: policy.mode, ...(policy.plan ? { plan: { ask: !!(store && threadId) } } : {}), unlock: policy.unlock ?? [], checks, sandbox, ...(context ? { context } : {}), ...(instructions ? { instructions } : {}), ...(remembered ? { memory: remembered } : {}), ...(skillList ? { skills: skillList } : {}), ...(profile?.instructions ? { profile: { name: profile.name, instructions: profile.instructions } } : {}) });

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  if (args.signal?.aborted) ac.abort();
  else args.signal?.addEventListener('abort', onSignal, { once: true });
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
  // The advisor's sessions: their turns do not count against the writer's, and their context is their own.
  const advised = new Set<HeadlessResult>();
  const turnsSpent = () => parts.reduce((n, r) => n + (advised.has(r) ? 0 : r.numTurns), 0);
  let handoffs = 0;
  // Quota waits add up across the run's sessions, against the one ceiling.
  let quotaWaited = 0;
  // child: a sub-thread's session, which gets the core tools only (no spawn, threads or inbox). A work sub-thread
  // hands off like the writer, and a session it handed off to gets recall over the sub-thread's earlier sessions.
  type RunOpts = {
    continues?: { sessionId: string; changed: string[] };
    // What the parts of a split plan changed before the writer started.
    inherited?: string[];
    note?: string;
    role?: 'plan' | 'review' | 'explore' | 'goal' | 'advisor' | 'classifier';
    child?: { thread?: string; handoff?: boolean; recall?: ToolSpec; place?: { cwd: string; preamble: string; snapshots: Snapshots; wrap: (command: string) => Promise<string> } };
    // Starts the session from another one's summary and the turns it kept (core/project/compact.ts).
    seed?: { from: SessionLog; compaction: NonNullable<HeadlessResult['compaction']> };
  };
  // What the session after a handoff starts from: the summary and kept turns, or the task and the note.
  const successor = (from: SessionLog, r: HeadlessResult): RunOpts => ({
    continues: { sessionId: from.id, changed: r.evidence?.changed ?? [] },
    ...(r.compaction ? { seed: { from, compaction: r.compaction }, note: compactedNote(from.id) } : { note: handoffNote(from.id, r.result) }),
  });
  const handingOff = (r: HeadlessResult, sub: boolean) =>
    say(
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
    const spawnHere = header?.tools.some((d) => d.name === 'spawn' && d.description === spawnOther.description) ? spawnOther : spawn;
    // With skills, or on a resumed session that had the tool: its tool list stays as it was even when the skills
    // are gone since, and a call to one that is gone says so.
    const withSkill = skills.length > 0 || !!header?.tools.some((d) => d.name === 'skill');
    // MCP tools: all for the writer, the read-only ones for reviewers and sub-threads. A resumed session whose
    // server is gone keeps the tool, and a call to it says the server is not there.
    const mcpTools = [...(mcp?.tools ?? []), ...(header?.tools ?? []).filter((d) => d.name.startsWith('mcp__') && !mcp?.tools.some((t) => t.name === d.name)).map(mcpStub)];
    const mcpRead = mcpTools.filter((t) => t.effect === 'read');
    // A resumed session that had the browser keeps the tool when this run has none, and a call says so.
    const browserTools = browser ? [browser.tool] : header?.tools.some((d) => d.name === BROWSER_TOOL) ? [browserStub] : [];
    const extra = [...(spawnOn ? [spawnHere] : []), ...((askOn || policy.plan) && store && threadId ? [askTool] : []), ...(todoOn && store && threadId ? [todoTool(store, threadId, runId)] : []), ...(profile?.openThread && store && threadId ? [openThreadTool(store, threadId, opened)] : []), ...(profile?.schedule && store && threadId ? [scheduleTool(new ScheduleStore(schedulesPath(cediaHome(), projectKey(args.cwd))), threadId)] : []), ...(earlier.some((s) => s.id !== log.id) ? [recall] : []), ...(store && threadId && others ? threadTools(store, threadId) : []), ...(remember ? [remember] : []), ...(withSkill ? [skill] : []), webFetch, ...browserTools, ...mcpTools];
    // The advisor and the classifier answer in one reply, with no tools, in a session of their own.
    const helper = opts.role === 'advisor' || opts.role === 'classifier';
    const tools = helper ? [] : reviewer ? [...REVIEW_TOOLS, ...(withSkill ? [skill] : []), webFetchRead, ...mcpRead] : child ? [...CORE_TOOLS, ...(child.recall ? [child.recall] : []), ...(withSkill ? [skill] : []), webFetch, ...mcpRead] : header ? [...CORE_TOOLS, ...extra].filter((t) => header.tools.some((d) => d.name === t.name)) : [...CORE_TOOLS, ...extra];
    // A work sub-thread in a worktree works there: its own directory, environment line and snapshots.
    const place = child?.place;
    if (writing) writerRuns.push({ log, from: log.events.length });
    const result = await runPrompt(
      {
        log,
        provider: providerOf(m),
        model: m,
        // Plan and review get no write tools, and their policy is read-only whatever the run's mode.
        tools,
        system: opts.role === 'advisor' ? ADVISOR_SYSTEM : opts.role === 'classifier' ? CLASSIFIER_SYSTEM : BASE_SYSTEM,
        ...(helper ? {} : { preamble: reviewer ? reviewPreamble : opts.note ? `${place?.preamble ?? basePreamble}\n\n${opts.note}` : (place?.preamble ?? basePreamble) }),
        cwd: place?.cwd ?? args.cwd,
        // They may also run the declared checks, to see what fails instead of only reading.
        // The run's own allow rules are the writer's: one such as bash(git *) would let a reviewer write.
        permission: reviewer ? { ...policy, mode: 'read-only', allow: checks.map((c) => `bash(${c})`) } : policy,
        privacy,
        // Stop hooks judge the writer's claim of done, not a plan, a review or a sub-thread's report.
        ...(hooked ? { hooks: writing ? hooks : { ...hooks, stop: [] }, hookHome: cediaHome() } : {}),
        checks: reviewer ? [] : checks,
        ...(softChecks && !reviewer ? { softChecks } : {}),
        ...(sandbox.on ? { wrap: place?.wrap ?? sandbox.wrap } : {}),
        // Not in a worktree: the language servers read the parent's working directory.
        ...(diagnoser && !reviewer && !place ? { diagnose: diagnoser.diagnose } : {}),
        ...(place ? { snapshots: place.snapshots } : snapshots && !reviewer ? { snapshots } : {}),
        ...(continues ? { continues } : {}),
        ...(opts.inherited?.length ? { inherited: opts.inherited } : {}),
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
                delivered: (ids: string[]) => store.append(threadId, { run: runId, kind: 'delivered', ids, sessionId: log.id }),
              },
            }
          : {}),
        signal: ac.signal,
        // An advisor out of quota is dropped at once: the writer never waits on an optional helper.
        ...(quotaWaitMs !== undefined && !helper
          ? { quotaWaitMs: quotaWaitMs - quotaWaited, onQuotaWait: (ms: number) => ((quotaWaited += ms), say(`cedia: ${m.ref} is out of quota; waiting ${Math.ceil(ms / 60_000)} min for it to come back\n`)) }
          : {}),
        ...(helper ? (m.defaultEffort ? { effort: 'low' as Effort } : {}) : args.effort ?? m.defaultEffort ? { effort: args.effort ?? m.defaultEffort } : {}),
        ...(escalate && !reviewer ? { escalate } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns - usedTurns } : {}),
        // One reply a turn, and one more if that came back empty.
        ...(helper ? { maxTurns: 2 } : {}),
        ...(writing && advise ? { advise } : {}),
        // Every session that may write: the writer's, a fix's, a sub-thread's.
        ...(!reviewer && classify ? { classify } : {}),
        ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd, meter } : {}),
        // The advisor's tokens are not the writer's reply: a client drawing the stream would show them as one.
        ...(args.outputFormat === 'stream-json' && !helper ? { onStream: (event) => out(encode({ type: 'stream', event })) } : {}),
      },
      prompt,
    );
    parts.push(result);
    if (child) children.add(result);
    if (helper) advised.add(result);
    return result;
  };
  // A plan or review step, in cedia or through the user's own Claude Code.
  const side = async (role: 'plan' | 'review', choice: RoleChoice, prompt: string): Promise<{ ok: boolean; text: string; step: Step }> => {
    if (choice.via === 'claude-code') {
      const step: Step = { model: `claude-code:${choice.model}@${choice.effort}`, via: 'claude-code', sessionId: '' };
      if (privacy === 'zdr') {
        say(`cedia: privacy is zdr, so the ${role} step does not go to Claude Code\n`);
        return { ok: false, text: '', step };
      }
      const allowed = ['Read', 'Grep', 'Glob', ...(role === 'review' ? GIT_READS : []), ...checks.map((c) => `Bash(${c})`)];
      const r = await runClaudeCode({ prompt, model: choice.model, effort: choice.effort, cwd: args.cwd, allowed, signal: ac.signal });
      if (!r.ok) say(`cedia: the ${role} step in Claude Code failed: ${r.error}\n`);
      return { ok: r.ok, text: r.text, step: { ...step, sessionId: r.sessionId, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) } };
    }
    const log = openLog();
    const r = await run(choice.model, log, prompt, { role });
    if (r.subtype !== 'success') say(`cedia: the ${role} step on ${choice.model.ref} ended with ${r.subtype}\n`);
    return { ok: r.subtype === 'success', text: r.result, step: { model: choice.model.ref, via: 'cedia', sessionId: log.id, costUsd: r.costUsd } };
  };
  // A thread that asked the owner a question goes on with their answer, framed as one.
  let task = resumed?.question ? answerPrompt(resumed.question.question, args.prompt) : (skillCommand(args.prompt, skills) ?? args.prompt);
  // The advisor: one session for the run, which reads each of the writer's turns and answers OK or a note. A
  // failed advisor (its quota, an error) is left out for the rest of the run; the writer goes on without it.
  const adv = { log: undefined as SessionLog | undefined, turns: 0, notes: 0, costUsd: 0, off: false };
  const advise = roles.advisor
    ? async (turn: SessionEvent[]): Promise<string | undefined> => {
        if (adv.off || ac.signal.aborted) return undefined;
        const first = !adv.log;
        adv.log ??= openLog();
        adv.turns++;
        const r = await run(roles.advisor!, adv.log, advicePrompt(first ? task : undefined, turnDigest(turn, adv.turns)), { role: 'advisor' });
        adv.costUsd += r.costUsd;
        // A long run outgrows one advisor session: the next turn starts a new one, from the task again.
        if ((r.peakContext ?? 0) >= defaultHandoffAt(roles.advisor!)) adv.log = undefined;
        if (r.subtype !== 'success') {
          adv.off = true;
          if (r.subtype !== 'interrupted') say(`cedia: the advisor on ${roles.advisor!.ref} ended with ${r.subtype}; going on without it\n`);
          return undefined;
        }
        const note = adviceOf(r.result);
        if (!note) return undefined;
        adv.notes++;
        return adviceReminder(roles.advisor!.ref, note);
      }
    : undefined;
  // The classifier: a session of its own for each command the mode alone would allow, which answers ALLOW or
  // BLOCK. Unlike the advisor it does not drop out when it fails: a guard that is not answering blocks, and the
  // writer is told why, so it can do what it can without the command.
  const cls = { last: undefined as string | undefined, calls: 0, blocked: 0, costUsd: 0 };
  // The user's own words, read again for each command so a message the user sent the thread mid-run counts: the
  // thread's first task, this run's prompt when it goes on with the thread, and the user's messages.
  const ownerTask = () => {
    const t = store && threadId ? store.read(threadId) : undefined;
    const first = t?.task ?? args.prompt;
    const said = (t?.messages ?? []).filter((m) => m.from === 'user' && !m.unsent).map((m) => `The user said later: ${m.text}`);
    return [first, ...(args.prompt !== first ? [`The user, going on with it: ${args.prompt}`] : []), ...said].join('\n\n');
  };
  const classify = roles.classifier
    ? async (call: { tool: string; input: JsonObject; cwd: string }): Promise<Verdict> => {
        if (ac.signal.aborted) return { decision: 'deny', reason: 'the run was stopped' };
        if (callText(call).length > MAX_INPUT) {
          cls.calls++;
          cls.blocked++;
          return { decision: 'deny', reason: `the command is longer than the classifier reads (${MAX_INPUT} characters); split it into shorter ones` };
        }
        const log = openLog();
        cls.last = log.id;
        cls.calls++;
        const r = await run(roles.classifier!, log, classifyPrompt(ownerTask(), call, call.cwd, call.tool === 'bash' ? namedFiles(callText(call), call.cwd) : []), { role: 'classifier' });
        cls.costUsd += r.costUsd;
        const v: Verdict = r.subtype === 'success' ? verdictOf(r.result) : { decision: 'deny', reason: `the classifier on ${roles.classifier!.ref} did not answer (${r.subtype}), so nothing it has not read runs` };
        if (v.decision === 'deny' && !ac.signal.aborted) cls.blocked++;
        return v;
      }
    : undefined;
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
  // A work sub-thread with worktrees on runs in a git worktree of its own (core/project/worktree.ts), beside the
  // others; only applying its changes runs alone, through ctx.write. Where no worktree can be made (no git, no
  // commit yet) it runs in place as it would without them, through ctx.write as a whole.
  const openWt = () => {
    const base = snapshots?.take();
    return snapshots && base ? openWorktree(args.cwd, snapshots, base, `${threadId ?? 'run'}-${subthreads + 1}-${crypto.randomUUID().slice(0, 8)}`) : { error: 'cedia cannot record this working tree' };
  };
  // One sub-thread run to its end, in `wt` when it has one; its changes are not applied yet.
  type Ran = { wt?: Worktree; sub?: string; m: ModelSpec; r: HeadlessResult };
  const runSub = async (brief: string, kind: SpawnKind, wt: Worktree | undefined, on?: ModelSpec): Promise<Ran> => {
    subthreads++;
    spawned[kind]++;
    let m = on ?? (kind === 'explore' ? explorer : writer.model);
    let sub: string | undefined;
    let place: NonNullable<RunOpts['child']>['place'];
    try {
      sub = store?.open(brief, threadId ? { parent: threadId } : {});
      // Its bash writes only in its worktree: the parent's files change only when its changes are applied.
      place = wt && { cwd: wt.cwd, snapshots: wt.snapshots, preamble: preamble(wt.cwd, { mode: policy.mode, unlock: policy.unlock ?? [], checks, sandbox, ...(context ? { context } : {}) }), wrap: sandbox.within(wt.dir) };
    } catch (e) {
      wt?.close();
      throw e;
    }
    const prompt = subtaskPrompt(brief, threadId, kind, wt?.cwd);
    // The sub-thread's sessions so far: what recall searches once one has handed off.
    const mine: EarlierSession[] = [];
    const recallMine = recallTool(() => mine.slice(0, -1));
    let handoffsHere = 0;
    let cost = 0;
    const once = async (why: SessionWhy, opts: RunOpts = {}) => {
      const log = openLog();
      if (store && sub) store.append(sub, { kind: 'session', sessionId: log.id, model: m.ref, role: kind === 'explore' ? 'explore' : 'code', why, ...(log.path ? { path: log.path } : {}) });
      mine.push({ id: log.id, events: () => log.events });
      const child = { ...(sub ? { thread: sub } : {}), ...(kind === 'work' && handoffsHere < MAX_HANDOFFS ? { handoff: true } : {}), ...(mine.length > 1 ? { recall: recallMine } : {}), ...(place ? { place } : {}) };
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
        say(`cedia: ${m.ref} is out of quota; the explore sub-thread goes on on ${writer.model.ref}\n`);
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
      wt?.close();
      if (store && sub) store.append(sub, { kind: 'state', state: 'failed', result: (e as Error).message });
      throw e;
    }
    return { ...(wt ? { wt } : {}), ...(sub ? { sub } : {}), m, r };
  };
  // Its changes reach the parent's files whole or not at all (a conflict writes nothing), however it ended, as
  // they would have in place: a child whose check cannot pass until another child's part lands is common, and
  // the parent's done gate wants a check after them either way. Only a stop leaves them out, and `drop` (a best
  // of N try that was not kept), which also removes its worktree. What did not come back stays in the worktree
  // for the parent to read, unless the run was stopped.
  const land = async ({ wt, sub, m, r }: Ran, ctx: Parameters<Spawner>[2], drop?: string): Promise<SpawnOutcome> => {
    let worktree: SpawnOutcome['worktree'];
    if (wt && drop) {
      wt.close();
      worktree = { applied: [], refused: [], conflicts: [], why: drop };
    } else if (wt && ctx.write) {
      const w = wt;
      // What the parent's own edit could not write: its deny rules, secret stores and protected paths, and
      // what the sandbox keeps bash from writing.
      const refuse = (f: string) => decide(policy, editTool, { path: f }, args.cwd).decision === 'deny' || sandboxGuarded(f);
      try {
        // A stop that came while it waited for the parent's files is still a stop.
        const applied = r.subtype !== 'interrupted' && !ac.signal.aborted ? await ctx.write(() => (ac.signal.aborted ? undefined : applyWorktree(w, snapshots!, refuse))) : undefined;
        const keep = !ac.signal.aborted && (!applied || applied.conflicts.length > 0 || applied.refused.length > 0);
        worktree = { applied: applied?.files ?? [], refused: applied?.refused ?? [], conflicts: applied?.conflicts ?? [], ...(applied?.newest ? { newest: applied.newest } : {}), ...(applied ? {} : { why: `the sub-thread ended with ${ac.signal.aborted ? 'a stop' : r.subtype}` }), ...(keep ? { kept: w.cwd } : {}) };
        if (keep) w.keep();
        else w.close();
      } catch (e) {
        // A worktree that is no longer the one made is not offered to be read: it may lead anywhere now.
        const intact = w.intact();
        if (intact) w.keep();
        else w.close();
        worktree = { applied: [], refused: [], conflicts: [], why: (e as Error).message, ...(intact ? { kept: w.cwd } : {}) };
      }
    }
    if (store && sub) {
      store.append(sub, { kind: 'state', state: worktree?.conflicts.length ? 'failed' : stateOf(r), result: r.result.slice(0, MAX_RESULT) });
      if (r.subtype === 'success' && !worktree?.conflicts.length) store.append(sub, { kind: 'archived', archived: true });
    }
    return { ...(sub ? { thread: sub } : {}), model: m.ref, subtype: r.subtype, result: r.result, costUsd: r.costUsd, changed: r.evidence?.changed ?? [], unverified: r.evidence?.unverified ?? [], ...(worktree ? { worktree } : {}) };
  };
  // The run's checks in a worktree, run by cedia in the child's sandbox: how many exit 0.
  const passing = async (wt: Worktree) => {
    let passed = 0;
    for (const command of checks) {
      if (ac.signal.aborted) break;
      const out = await bashTool.run({ command, timeout_ms: 600_000 }, { cwd: wt.cwd, signal: ac.signal, wrap: sandbox.within(wt.dir) });
      if (out.exitCode === 0) passed++;
    }
    return passed;
  };
  // Best of N (core/project/bestof.ts): one work sub-thread per approach, each in a worktree of its own, all at
  // once; then the run's checks in each, and only the one that passes most is applied.
  const race = async (brief: string, approaches: string[], ctx: Parameters<Spawner>[2]): Promise<SpawnOutcome> => {
    const wts: Worktree[] = [];
    for (const _ of approaches) {
      const w = openWt();
      if ('error' in w) {
        for (const o of wts) o.close();
        say(`cedia: no worktree for best of ${approaches.length} (${w.error}); the first approach runs in place, alone\n`);
        return ctx.write!(() => spawner(`${brief}\n\nTake this approach: ${approaches[0]}`, 'work', { signal: ctx.signal }));
      }
      wts.push(w);
    }
    const settled = await Promise.allSettled(approaches.map((a, i) => runSub(approachBrief(brief, a, approaches.length), 'work', wts[i])));
    const ran = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    if (!ran.length) throw (settled[0] as PromiseRejectedResult).reason;
    const tries: Try[] = [];
    for (const [i, s] of settled.entries()) {
      if (s.status === 'rejected') {
        tries.push({ approach: approaches[i]!, subtype: 'error_during_execution', passed: 0, checks: checks.length, unverified: 0, costUsd: 0 });
        continue;
      }
      const { wt, sub, r } = s.value;
      const passed = wt && r.subtype !== 'interrupted' && !ac.signal.aborted && wt.intact() ? await passing(wt) : 0;
      tries.push({ approach: approaches[i]!, ...(sub ? { thread: sub } : {}), subtype: ac.signal.aborted ? 'interrupted' : r.subtype, passed, checks: checks.length, unverified: r.evidence?.unverified.length ?? 0, costUsd: r.costUsd });
    }
    const kept = bestTry(tries);
    const outcomes: (SpawnOutcome | undefined)[] = [];
    for (const [i, s] of settled.entries()) outcomes.push(s.status === 'fulfilled' ? await land(s.value, ctx, i === kept ? undefined : kept === undefined ? undefined : `approach ${kept + 1} was kept instead`) : undefined);
    const first = outcomes[kept ?? outcomes.findIndex(Boolean)]!;
    return { ...first, costUsd: tries.reduce((sum, t) => sum + t.costUsd, 0), bestOf: { tries, ...(kept !== undefined ? { kept } : {}) } };
  };
  const spawner: Spawner = async (brief: string, kind: SpawnKind, ctx) => {
    if (kind === 'work' && ctx.write && ctx.approaches) return race(brief, ctx.approaches, ctx);
    let wt: Worktree | undefined;
    if (kind === 'work' && ctx.write) {
      const w = openWt();
      if ('error' in w) {
        say(`cedia: no worktree for the work sub-thread (${w.error}); it runs in place, alone\n`);
        return ctx.write(() => spawner(brief, kind, { signal: ctx.signal }));
      }
      wt = w;
    }
    return land(await runSub(brief, kind, wt), ctx);
  };
  const pool = spawnPool();
  const spawn = spawnTool(spawner, undefined, { worktrees: spawnMode === 'worktree', pool });
  // A resumed session keeps the spawn tool it was opened with, worktrees or not, so its tool list stays the same.
  const spawnOther = spawnTool(spawner, undefined, { worktrees: spawnMode !== 'worktree', pool });
  // The parts of a split plan, before the writer starts (core/roles.ts): each a work sub-thread from its brief, on
  // the model the planner picked, all at once in worktrees of their own or else one after another in place. What
  // they changed comes back like a sub-thread's changes; the writer's done gate wants a check after it.
  const delegate = async (planned: Part[]): Promise<{ reports: string[]; changed: string[] }> => {
    const allowed = new Map([model, ...roles.workers].map((m) => [m.ref, m]));
    const on = (p: Part) => {
      if (!p.model) return model;
      let m: ModelSpec | undefined;
      try {
        m = allowed.get(resolveModel(p.model).ref);
      } catch {}
      if (!m) say(`cedia: the plan put a part on ${p.model}, which is not one of the workers; it runs on ${model.ref}\n`);
      return m ?? model;
    };
    const take = planned.slice(0, Math.max(0, pool.total - pool.started));
    pool.started += take.length;
    // Outside a turn nothing else writes the parent's files, and the parts land one at a time.
    const ctx = { signal: ac.signal, write: <T>(fn: () => Promise<T> | T) => Promise.resolve(fn()) };
    const outcomes: SpawnOutcome[] = [];
    const wts = spawnMode === 'worktree' ? take.map(() => openWt()) : [];
    const failed = wts.find((w): w is { error: string } => 'error' in w);
    if (wts.length && !failed) {
      const settled = await Promise.allSettled(take.map((p, i) => runSub(p.brief, 'work', wts[i] as Worktree, on(p))));
      for (const r of settled) if (r.status === 'fulfilled') outcomes.push(await land(r.value, ctx));
    } else {
      for (const w of wts) if (!('error' in w)) w.close();
      if (failed) say(`cedia: no worktree for the plan's parts (${failed.error}); they run in place, one after another\n`);
      for (const p of take) if (!ac.signal.aborted) outcomes.push(await land(await runSub(p.brief, 'work', undefined, on(p)), { signal: ac.signal }));
    }
    return { reports: outcomes.map((o) => spawnReport('work', o)), changed: [...new Set(outcomes.flatMap((o) => o.worktree?.applied ?? o.changed))] };
  };
  // Runs the writer and follows its handoffs: each note opens a new session of the thread on the same model,
  // which starts from the task (and the fix it was on, if any) and the note.
  // `lead` goes before the prompt in this session only, not in what a handoff carries.
  const write = async (m: ModelSpec, log: SessionLog, prompt: string, opts: RunOpts = {}, lead?: string) => {
    writer = { model: m, log };
    let r = await run(m, log, lead ? `${lead}\n\n${prompt}` : prompt, opts);
    while (r.subtype === 'handoff') {
      handoffs++;
      const from = writer.log;
      if (store && threadId) store.append(threadId, { run: runId, kind: 'handoff', sessionId: from.id, note: r.result });
      handingOff(r, false);
      writer = { model: m, log: openLog() };
      record(writer.log, m, 'handoff');
      const carry = prompt === task ? task : `${task}\n\n${prompt}`;
      r = await run(m, writer.log, carry, successor(from, r));
    }
    return r;
  };
  // Where this run starts, for /rewind: the working tree, and the conversation as the thread's last writer session
  // has it now (core/project/rewind.ts).
  if (store && threadId) {
    const last = resumed?.sessions.findLast((s) => s.role === 'code' && !resumed.rewound.includes(s.sessionId));
    const tree = snapshots?.take();
    const from = last?.path && sessionExists(last.path) ? { sessionId: last.sessionId, path: last.path, events: SessionLog.load(last.path).events.length, model: last.model } : undefined;
    store.append(threadId, { kind: 'run', id: runId, prompt: args.prompt.slice(0, 500), cwd: args.cwd, ...(tree ? { tree } : {}), ...(from ? { from } : {}), permission });
  }
  try {
    const servers = loadMcp();
    if (Object.keys(servers).length) {
      mcp = await startMcp(servers);
      for (const n of mcp.notes) say(n + '\n');
    }
    // Plan: a stronger model reads the repo and writes the plan the writer gets with the task.
    let plan: Step | undefined;
    // What the plan's parts changed before the writer started.
    let inherited: string[] = [];
    if (roles.plan) {
      // With spawn on, the planner may split the work into parts that cedia hands to work sub-threads before the
      // writer starts: what to delegate, and to which model, is the stronger model's call (no DeepSeek run ever
      // delegated on its own).
      const split: Split | undefined = !spawnOn || policy.plan || policy.mode === 'read-only' ? undefined : { mode: spawnMode === 'worktree' ? 'parallel' : 'alone', writer: model.ref, workers: roles.workers.filter((w) => w.ref !== model.ref).map((w) => w.ref) };
      const p = await side('plan', roles.plan, planPrompt(task, split));
      if (p.ok && p.text.trim()) {
        task = withPlan(task, p.text.trim(), p.step.model);
        const planned = split ? planParts(p.text) : [];
        if (planned.length) {
          say(`cedia: the plan splits off ${planned.length} parts; each goes to a work sub-thread first\n`);
          const done = await delegate(planned);
          if (done.reports.length) task = withParts(task, done.reports);
          inherited = done.changed;
        }
        plan = p.step;
      } else say('cedia: going on without a plan\n');
    }
    // A resumed thread goes on in its last session when the model is the same (its cache may still be warm) and
    // the provider still takes that session's history, otherwise in a new session that starts from where the
    // thread stopped.
    const last = resumed?.sessions.findLast((s) => s.role === 'code' && !resumed.rewound.includes(s.sessionId));
    const lastLog = resumed && last?.model === model.ref && last.path && sessionExists(last.path) ? SessionLog.load(last.path) : undefined;
    let result: HeadlessResult;
    // A session whose cache has expired costs its whole context to resume; past a size, a new session from where
    // the thread stopped is cheaper, so the run says both prices and takes the cheaper.
    const freshTokens = resumed ? Math.ceil((BASE_SYSTEM.length + JSON.stringify(toolDefs(CORE_TOOLS)).length + basePreamble.length + resumeNote(resumed).length + task.length) / 4) : 0;
    const choice = lastLog ? resumeChoice(lastLog.events, model, freshTokens) : undefined;
    if (choice?.fresh)
      say(
        `cedia: thread ${threadId}'s last session has been idle ${Math.round(choice.idleMs / 60_000)} min, past its cache; resuming it re-reads ${Math.round(choice.contextTokens / 1000)}k tokens (about $${choice.resumeUsd.toFixed(3)}), a new session from where it stopped starts at about ${Math.round(freshTokens / 1000)}k ($${choice.freshUsd.toFixed(3)}), so it goes on in a new session\n`,
      );
    if (lastLog && !historyRejected(lastLog.events) && !choice?.fresh) {
      const log = lastLog;
      if (args.outputFormat === 'stream-json') log.listeners.push((event) => out(encode({ type: 'event', event })));
      record(log, model, 'resume');
      // Its first message named the mode it was opened under; a run under another one says so.
      const before = resumed?.runs.at(-1)?.permission;
      const header = log.events[0]?.kind === 'session' ? log.events[0] : undefined;
      const lead = before && before !== permission ? `<permission>\n${modeNote(policy.mode, policy.unlock ?? [], policy.plan ? { ask: !!header?.tools.some((d) => d.name === 'ask_user') } : undefined)}\n</permission>` : undefined;
      result = await write(model, log, task, inherited.length ? { inherited } : {}, lead);
    } else {
      const log = openLog();
      record(log, model, resumed ? 'resume' : 'start');
      result = await write(model, log, task, { ...(resumed ? { note: resumeNote(resumed) } : {}), ...(inherited.length ? { inherited } : {}) });
    }
    // A spent quota does not end the task: a new session on the fallback model picks it up (a session never
    // switches model, so its cache stays valid). Nor does a history the provider refuses: a new session on the
    // same model starts from the task and the working tree. Each happens at most once a run.
    // It applies to every writer pass: the first, a review's fix and a goal's next round.
    let fellBack = false;
    let restarted = false;
    const recover = async (r: HeadlessResult): Promise<HeadlessResult> => {
    let result = r;
    while (result.subtype === 'error_during_execution') {
      const from = writer;
      const changed = result.evidence?.changed ?? [];
      const rejected = historyRejected(from.log.events);
      if (fallback && !fellBack && quotaSpent(from.log.events)) {
        fellBack = true;
        say(`cedia: ${from.model.ref} is out of quota; continuing on ${fallback.ref} in a new session\n`);
        const note = missingKeyNote(fallback);
        if (note) say(note + '\n');
        const log = openLog();
        record(log, fallback, 'quota');
        result = await write(fallback, log, task, { continues: { sessionId: from.log.id, changed }, note: continueNote(from.model, from.log.id) });
      } else if (!restarted && rejected) {
        restarted = true;
        say(`cedia: ${from.model.ref} refused this session's history (${rejected.code}: ${rejected.message.slice(0, 200)}); continuing in a new session\n`);
        const log = openLog();
        record(log, from.model, 'rejected');
        result = await write(from.model, log, task, { continues: { sessionId: from.log.id, changed }, note: rejectedNote(from.model, from.log.id) });
      } else break;
    }
    return result;
    };
    result = await recover(result);
    // Review: after the writer's claim passed the done gate, a second model reads the change. Changes it asks
    // for go back to the writer's own session once.
    let review: ReviewOutcome | undefined;
    if (roles.review && result.subtype === 'success' && result.evidence?.changed.length) {
      const r = await side('review', roles.review, reviewPrompt(args.prompt, result.evidence, changesPatch()));
      const { verdict, findings } = r.ok ? parseVerdict(r.text) : { verdict: 'unclear' as const, findings: '' };
      review = { ...r.step, verdict, fixed: false };
      if (verdict === 'changes') {
        result = await recover(await write(writer.model, writer.log, fixPrompt(r.step.model, findings)));
        review.fixed = true;
      } else if (verdict === 'unclear') say(`cedia: the review by ${r.step.model} gave no verdict; keeping the change as it is\n`);
    }
    // Goal: a separate judge decides whether the condition holds; while it does not, the writer goes on in its
    // own session with what the judge found missing, up to MAX_GOAL_ROUNDS more passes.
    let goal: HeadlessResult['goal'];
    if (args.goal && goalJudge) {
      const rounds: GoalRound[] = [];
      while (result.subtype === 'success' && !ac.signal.aborted) {
        const log = openLog();
        if (store && threadId) store.append(threadId, { kind: 'session', sessionId: log.id, model: goalJudge.ref, role: 'goal', why: 'start', ...(log.path ? { path: log.path } : {}) });
        // The receipt of the whole run so far: a later round's own pass changed only part of it.
        const r = await run(goalJudge, log, goalPrompt(args.goal, args.prompt, result.result, combine(parts, result, children).evidence, changesPatch()), { role: 'goal' });
        const judged = r.subtype === 'success' ? parseGoal(r.result) : undefined;
        rounds.push({ verdict: judged?.verdict ?? 'not_met', reason: judged?.reason ?? `the judge's session ended with ${r.subtype}`, judge: goalJudge.ref, sessionId: log.id, costUsd: r.costUsd });
        // A judge that could not finish says nothing about the work, so the writer is not sent back on it.
        if (!judged || judged.verdict !== 'not_met' || rounds.length > MAX_GOAL_ROUNDS) break;
        say(`cedia goal: not met yet (round ${rounds.length}); the writer goes on with what the judge found missing\n`);
        result = await recover(await write(writer.model, writer.log, goalContinuePrompt(args.goal, goalJudge.ref, judged.reason)));
      }
      const last = rounds.at(-1);
      goal = { condition: args.goal, verdict: last?.verdict ?? 'not_met', rounds };
    }
    const sessions = [...new Set(writerRuns.map((w) => w.log.id))];
    const classified = cls.calls ? { model: roles.classifier!.ref, via: 'cedia' as const, sessionId: cls.last ?? '', costUsd: cls.costUsd, calls: cls.calls, blocked: cls.blocked } : undefined;
    const advice = adv.log ? { model: roles.advisor!.ref, via: 'cedia' as const, sessionId: adv.log.id, costUsd: adv.costUsd, turns: adv.turns, notes: adv.notes } : undefined;
    result = { ...combine(parts, result, new Set([...children, ...advised]), advised), ...(plan ? { plan } : {}), ...(review ? { review } : {}), ...(advice ? { advice } : {}), ...(goal ? { goal } : {}), ...(classified ? { classified } : {}), ...(threadId ? { thread: threadId } : {}), sessions, ...(subthreads ? { subthreads, spawned } : {}) };
    recordTurn();
    if (store && threadId && result.question) store.append(threadId, { run: runId, kind: 'question', sessionId: result.sessionId, ...result.question });
    if (store && threadId) store.append(threadId, { run: runId, kind: 'state', state: goal && goal.verdict !== 'met' && result.subtype === 'success' ? 'failed' : stateOf(result), result: result.result.slice(0, MAX_RESULT) });
    // The receipt goes in the writer's log too, so a thread rebuilt from the files shows it. Quiet: a stream-json
    // client gets it as the result line below.
    writer.log.append({ kind: 'result', result }, { quiet: true });
    if (args.outputFormat === 'text') {
      out(result.result + (result.result.endsWith('\n') ? '' : '\n'));
      if (result.evidence) say(receipt(result.evidence, result.thread) + '\n');
      if (result.plan) say(`cedia plan: by ${result.plan.model}\n`);
      if (result.goal) say(`cedia goal: ${result.goal.verdict.replace('_', ' ')} after ${result.goal.rounds.length} judgement${result.goal.rounds.length === 1 ? '' : 's'} by ${goalJudge!.ref}${result.goal.verdict === 'met' ? '' : `: ${result.goal.rounds.at(-1)?.reason.split('\n')[0] ?? ''}`}\n`);
      if (result.classified) say(`cedia classifier: ${result.classified.model} read ${result.classified.calls} command${result.classified.calls === 1 ? '' : 's'} and blocked ${result.classified.blocked}\n`);
      if (result.advice) say(`cedia advisor: ${result.advice.model} read ${result.advice.turns} turn${result.advice.turns === 1 ? '' : 's'} and left ${result.advice.notes} note${result.advice.notes === 1 ? '' : 's'}\n`);
      if (result.review) say(`cedia review: ${result.review.model} ${result.review.verdict === 'changes' ? 'asked for changes, sent back to the writer once' : result.review.verdict === 'approve' ? 'approved' : 'gave no verdict'}\n`);
      if (threadId) say(`cedia thread: ${threadId}${handoffs ? ` (${handoffs} handoff${handoffs === 1 ? '' : 's'})` : ''}; go on with --thread ${threadId}\n`);
    }
    else out(encode(result));
    return result;
  } catch (e) {
    recordTurn();
    if (store && threadId) store.append(threadId, { run: runId, kind: 'state', state: 'failed', result: (e as Error).message });
    throw e;
  } finally {
    await diagnoser?.close();
    await mcp?.close();
    await browser?.close();
    await sandbox.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    args.signal?.removeEventListener('abort', onSignal);
  }
}

const stateOf = (r: HeadlessResult) => (r.subtype === 'success' ? 'done' : r.subtype === 'asked' ? 'asking' : r.subtype === 'interrupted' ? 'stopped' : 'failed');
