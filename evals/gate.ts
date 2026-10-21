#!/usr/bin/env bun
// Usage: bun evals/gate.ts [--suite evals/gate/suite.json] [--model <ref>]... [--runs <n>] [--jobs <n>] [--budget <usd>]
//                          [--estimate] [--update-baseline] [--cedia-arg=<flag>]...
//        bun evals/gate.ts --compare <results.jsonl> [--against <results.jsonl|baseline.json>]
//
// The regression gate. Runs the suite's tasks on each model, records pass rate, false-done, cost and time, and
// compares them with the baseline stored for that model in evals/gate/baseline/. Exit 0 when no model got worse,
// 1 when one regressed, 3 when the comparison cannot be made (no baseline, too many provider errors, budget hit).
// It prints the expected cost from the baseline's own spend (or earlier results) before it starts, and refuses to start a run that
// would cost more than the suite's maxUsd unless --budget allows it.
//
// --compare scores an existing result file instead of running anything, so a rule change can be checked for free.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ALIASES } from "../src/core/providers/catalog.ts";
import { estimateCost, formatSummary, loadTasks, missingVerifyTools, REPO_ROOT, runAll, summarize, type Result, type Task } from "./run.ts";

export type Thresholds = {
  // One-sided Fisher exact test on passed runs: a lower pass rate fails the gate when p is below this.
  passP: number;
  // Mean cost or wall time per run, paired by task, may rise by this share before the gate fails.
  costRise: number;
  timeRise: number;
};

export type Suite = {
  name: string;
  tasks: string[];
  runs: number;
  // Runs at once. Stored with the baseline: wall time measured at another concurrency is not compared.
  jobs: number;
  models: string[];
  // The most a run of the whole suite may cost before --budget has to allow it.
  maxUsd: number;
  thresholds: Thresholds;
  cediaArgs?: string[];
  // Relative to the suite file; evals/tasks by default.
  tasksDir?: string;
};

export type Baseline = {
  suite: string;
  model: string;
  commit: string;
  date: string;
  runs: number;
  jobs: number;
  cediaArgs: string[];
  // A task whose content changed since the baseline is not compared: its old numbers measure another task.
  taskHashes: Record<string, string>;
  results: Result[];
};

export type Check = {
  name: string;
  baseline: string;
  candidate: string;
  // regressed fails the gate; worse is a drop the runs cannot tell from noise; skipped says why in note.
  status: "ok" | "better" | "worse" | "regressed" | "skipped";
  note?: string;
};

export type Comparison = { model: string; verdict: "pass" | "regressed" | "inconclusive"; checks: Check[] };

export const DEFAULT_SUITE = resolve(import.meta.dir, "gate/suite.json");
export const BASELINE_DIR = resolve(import.meta.dir, "gate/baseline");

export const slug = (model: string) => model.replace(/[^a-zA-Z0-9.-]+/g, "_");
export const baselinePath = (model: string, dir = BASELINE_DIR) => join(dir, `${slug(model)}.json`);

// What decides a task's result: change any of it and the old numbers stop applying.
export function taskHash(t: Task): string {
  const { id, prompt, setup, verify, expectedExitCode, hidden, executable, timeoutSec, budgetUsd } = t;
  return createHash("sha256").update(JSON.stringify({ id, prompt, setup, verify, expectedExitCode, hidden, executable, timeoutSec, budgetUsd })).digest("hex").slice(0, 16);
}

// P(X <= k) for X hypergeometric: `draws` runs taken from `total`, of which `good` passed.
function hypergeomCdf(k: number, total: number, good: number, draws: number): number {
  const lf = (n: number) => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const lc = (n: number, r: number) => lf(n) - lf(r) - lf(n - r);
  let p = 0;
  for (let x = Math.max(0, draws - (total - good)); x <= Math.min(k, good, draws); x++) p += Math.exp(lc(good, x) + lc(total - good, draws - x) - lc(total, draws));
  return Math.min(1, p);
}

// One-sided Fisher exact test: how likely the candidate passes this few runs if both pass at the same rate.
export function fisherLower(candPass: number, candRuns: number, basePass: number, baseRuns: number): number {
  return hypergeomCdf(candPass, candRuns + baseRuns, candPass + basePass, candRuns);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const byTask = (rs: Result[]) => {
  const m = new Map<string, Result[]>();
  for (const r of rs) m.set(r.id, [...(m.get(r.id) ?? []), r]);
  return m;
};
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

// Paired by task, so a run that lost a task to provider errors is not cheaper for it: the sum over common tasks of
// each task's mean, candidate over baseline.
function pairedRatio(base: Map<string, Result[]>, cand: Map<string, Result[]>, f: (r: Result) => number | undefined): { base: number; cand: number } | undefined {
  let b = 0;
  let c = 0;
  for (const [id, crs] of cand) {
    const bv = (base.get(id) ?? []).map(f).filter((x): x is number => typeof x === "number");
    const cv = crs.map(f).filter((x): x is number => typeof x === "number");
    if (!bv.length || !cv.length) continue;
    b += mean(bv);
    c += mean(cv);
  }
  return b || c ? { base: b, cand: c } : undefined;
}

export function compare(
  baseAll: Result[],
  candAll: Result[],
  opts: { thresholds: Thresholds; planned?: number; staleTasks?: string[]; sameJobs?: boolean; model?: string },
): Comparison {
  const { thresholds: th } = opts;
  const stale = new Set(opts.staleTasks ?? []);
  const scored = (rs: Result[]) => rs.filter((r) => !r.infraError && !stale.has(r.id));
  const candTasks = new Set(scored(candAll).map((r) => r.id));
  const baseTasks = new Set(scored(baseAll).map((r) => r.id));
  const base = scored(baseAll).filter((r) => candTasks.has(r.id));
  const cand = scored(candAll).filter((r) => baseTasks.has(r.id));
  const checks: Check[] = [];
  const model = opts.model ?? candAll[0]?.model ?? baseAll[0]?.model ?? "?";

  if (stale.size) checks.push({ name: "tasks", baseline: "", candidate: "", status: "skipped", note: `changed since the baseline, not compared: ${[...stale].join(", ")}` });
  const planned = opts.planned ?? candAll.length;
  if (!cand.length || cand.length < 0.8 * planned) {
    checks.push({ name: "coverage", baseline: `${base.length} runs`, candidate: `${cand.length} of ${planned} runs`, status: "skipped", note: "fewer than 80% of the planned runs can be compared (provider errors, budget, or tasks missing from the baseline)" });
    return { model, verdict: "inconclusive", checks };
  }

  // Pass rate over every compared run.
  const bp = base.filter((r) => r.passed).length;
  const cp = cand.filter((r) => r.passed).length;
  const p = fisherLower(cp, cand.length, bp, base.length);
  const lower = cp / cand.length < bp / base.length;
  checks.push({
    name: "pass@1",
    baseline: `${pct(bp / base.length)} (${bp}/${base.length})`,
    candidate: `${pct(cp / cand.length)} (${cp}/${cand.length})`,
    status: lower ? (p < th.passP ? "regressed" : "worse") : cp / cand.length > bp / base.length ? "better" : "ok",
    ...(lower ? { note: `p = ${p.toFixed(3)}${p < th.passP ? "" : `, not below ${th.passP}: rerun with more --runs to tell it from noise`}` } : {}),
  });

  // A task that passed every baseline run and failed every candidate run is a regression on its own.
  const bt = byTask(base);
  const ct = byTask(cand);
  const broken = [...ct].filter(([id, rs]) => rs.length >= 2 && rs.every((r) => !r.passed) && (bt.get(id) ?? []).every((r) => r.passed)).map(([id, rs]) => `${id} (0/${rs.length}, was ${bt.get(id)!.length}/${bt.get(id)!.length})`);
  checks.push({ name: "tasks broken", baseline: "", candidate: broken.length ? broken.join(", ") : "none", status: broken.length ? "regressed" : "ok" });

  // A false done is the trust guarantee failing, so any rise fails the gate.
  const bf = base.filter((r) => r.falseDone).length;
  const cf = cand.filter((r) => r.falseDone).length;
  checks.push({
    name: "false-done",
    baseline: `${pct(bf / base.length)} (${bf})`,
    candidate: `${pct(cf / cand.length)} (${cf})`,
    status: cf / cand.length > bf / base.length ? "regressed" : cf / cand.length < bf / base.length ? "better" : "ok",
  });

  // `floor` is the smallest absolute rise that counts, so tasks of a few seconds cannot fail the gate on jitter.
  const rise = (name: string, f: (r: Result) => number | undefined, limit: number, floor: number, fmt: (x: number) => string, skip?: string) => {
    const r = pairedRatio(bt, ct, f);
    if (skip || !r) return checks.push({ name, baseline: r ? fmt(r.base) : "-", candidate: r ? fmt(r.cand) : "-", status: "skipped", note: skip ?? "not reported" });
    if (r.base < 1e-9) return checks.push({ name, baseline: fmt(r.base), candidate: fmt(r.cand), status: "skipped", note: "the baseline costs nothing" });
    const ratio = r.cand / r.base;
    checks.push({
      name,
      baseline: fmt(r.base),
      candidate: fmt(r.cand),
      status: ratio > 1 + limit && r.cand - r.base > floor ? "regressed" : ratio < 1 - limit && r.base - r.cand > floor ? "better" : "ok",
      note: `${ratio >= 1 ? "+" : ""}${pct(ratio - 1)} (limit +${pct(limit)})`,
    });
  };
  const nTasks = ct.size;
  rise("cost per task set", (r) => r.reported.costUsd, th.costRise, 0.002, (x) => `$${x.toFixed(4)}`);
  rise("time per task set", (r) => r.wallMs, th.timeRise, 10_000, (x) => `${(x / 1000).toFixed(0)}s`, opts.sameJobs === false ? "the baseline ran at another --jobs, which changes wall time" : undefined);
  // Reported, never gated: they explain a cost or time change.
  const turns = pairedRatio(bt, ct, (r) => r.reported.turns);
  if (turns) checks.push({ name: "turns per task set", baseline: turns.base.toFixed(0), candidate: turns.cand.toFixed(0), status: "ok", note: `${nTasks} tasks, not gated` });

  return { model, verdict: checks.some((c) => c.status === "regressed") ? "regressed" : "pass", checks };
}

export function formatComparison(c: Comparison): string {
  const mark = { ok: "  ", better: "+ ", worse: "~ ", regressed: "X ", skipped: "- " } as const;
  const w = Math.max(...c.checks.map((x) => x.name.length));
  return [
    `${c.model}: ${c.verdict.toUpperCase()}`,
    ...c.checks.map((x) => `  ${mark[x.status]}${x.name.padEnd(w)}  ${x.baseline ? `${x.baseline} -> ` : ""}${x.candidate}${x.note ? `  (${x.note})` : ""}`),
  ].join("\n");
}

const readRows = (path: string): Result[] =>
  readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Result);

function readBaseline(path: string): Baseline | undefined {
  if (!existsSync(path)) return undefined;
  if (path.endsWith(".jsonl")) {
    const results = readRows(path);
    return { suite: "", model: results[0]?.model ?? "", commit: "", date: "", runs: 0, jobs: 0, cediaArgs: [], taskHashes: {}, results };
  }
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

export function loadSuite(path: string): { suite: Suite; tasks: Task[] } {
  const suite = JSON.parse(readFileSync(path, "utf8")) as Suite;
  const tasksDir = suite.tasksDir ? resolve(dirname(path), suite.tasksDir) : resolve(import.meta.dir, "tasks");
  const all = new Map(loadTasks(tasksDir).map((t) => [t.id, t]));
  const tasks = suite.tasks.map((id) => {
    const t = all.get(id);
    if (!t) throw new Error(`suite ${suite.name}: no task ${id} in ${tasksDir}`);
    if (t.unavailable) throw new Error(`suite ${suite.name}: ${id}: ${t.unavailable}`);
    return t;
  });
  return { suite, tasks };
}

// Expected spend per task: the baseline's own mean cost, else the mean of that model's earlier result files, else
// the token estimate.
export function expectedCost(model: string, tasks: Task[], runs: number, baseline?: Baseline, history: Result[] = []): { usd: number; basis: string } {
  const costed = (rs: Result[]) => byTask(rs.filter((r) => typeof r.reported.costUsd === "number" && !r.infraError));
  const fromBase = costed(baseline?.results ?? []);
  const fromHistory = costed(history);
  let usd = 0;
  const used = { baseline: 0, history: 0, estimate: 0 };
  for (const t of tasks) {
    const b = fromBase.get(t.id);
    const h = fromHistory.get(t.id);
    if (b?.length) used.baseline++;
    else if (h?.length) used.history++;
    else used.estimate++;
    usd += b?.length || h?.length ? runs * mean((b?.length ? b : h)!.map((r) => r.reported.costUsd!)) : estimateCost(model, runs, baseline?.results).usd;
  }
  const basis = Object.entries({ baseline: "the baseline", history: "earlier results", estimate: "a token estimate" })
    .filter(([k]) => used[k as keyof typeof used])
    .map(([k, label]) => `${label} for ${used[k as keyof typeof used]}`)
    .join(", ");
  return { usd, basis: `${basis} of ${tasks.length} tasks` };
}

// Every earlier row of `model` in a results directory, aliases resolved.
export function historyOf(model: string, dir: string): Result[] {
  if (!existsSync(dir)) return [];
  const ref = (m: string | null) => (m ? (ALIASES[m] ?? m) : "");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => {
      try {
        return readRows(join(dir, f));
      } catch {
        return [];
      }
    })
    .filter((r) => ref(r.model) === ref(model));
}

const gitHead = () => Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim();
const gitDirty = () => Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: REPO_ROOT }).stdout.toString().trim() !== "";

async function main(argv: string[]): Promise<number> {
  let suitePath = DEFAULT_SUITE;
  let baselineDir = BASELINE_DIR;
  let resultsDir = resolve(import.meta.dir, "results");
  const models: string[] = [];
  let runs: number | undefined;
  let jobs: number | undefined;
  let budget: number | undefined;
  let estimate = false;
  let update = false;
  let comparePath: string | undefined;
  let againstPath: string | undefined;
  const cediaArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--suite") suitePath = argv[++i]!;
    else if (a === "--baseline-dir") baselineDir = argv[++i]!;
    else if (a === "--results-dir") resultsDir = argv[++i]!;
    else if (a === "--model" || a === "-m") models.push(argv[++i]!);
    else if (a === "--runs") runs = Number(argv[++i]);
    else if (a === "--jobs") jobs = Number(argv[++i]);
    else if (a === "--budget") budget = Number(argv[++i]);
    else if (a === "--estimate") estimate = true;
    else if (a === "--update-baseline") update = true;
    else if (a === "--compare") comparePath = argv[++i]!;
    else if (a === "--against") againstPath = argv[++i]!;
    else if (a === "--cedia-arg" || a.startsWith("--cedia-arg=")) cediaArgs.push(a.includes("=") ? a.slice("--cedia-arg=".length) : argv[++i]!);
    else throw new Error(`unknown flag: ${a}`);
  }
  const { suite, tasks } = loadSuite(suitePath);
  const hashes = Object.fromEntries(tasks.map((t) => [t.id, taskHash(t)]));
  const staleOf = (b: Baseline) => (Object.keys(b.taskHashes).length ? tasks.filter((t) => b.taskHashes[t.id] && b.taskHashes[t.id] !== hashes[t.id]).map((t) => t.id) : []);

  if (comparePath) {
    const cand = readRows(comparePath);
    const model = cand[0]?.model ?? "";
    const base = readBaseline(againstPath ?? baselinePath(model, baselineDir));
    if (!base) {
      console.error(`no baseline for ${model} at ${baselinePath(model, baselineDir)}`);
      return 3;
    }
    const c = compare(base.results, cand, { thresholds: suite.thresholds, staleTasks: staleOf(base), model });
    console.log(formatComparison(c));
    return c.verdict === "pass" ? 0 : c.verdict === "regressed" ? 1 : 3;
  }

  runs ??= suite.runs;
  jobs ??= suite.jobs;
  const args = [...(suite.cediaArgs ?? []), ...cediaArgs];
  if (!models.length) models.push(...suite.models);
  const baselines = new Map(models.map((m) => [m, readBaseline(baselinePath(m, baselineDir))]));

  let total = 0;
  console.log(`Suite ${suite.name}: ${tasks.length} tasks x ${runs} runs per model, ${jobs} at a time`);
  for (const m of models) {
    const e = expectedCost(m, tasks, runs, baselines.get(m), historyOf(m, resultsDir));
    total += e.usd;
    const b = baselines.get(m);
    console.log(`  ${m}: about $${e.usd.toFixed(3)} (${e.basis})${b ? `; baseline ${b.commit} of ${b.date.slice(0, 10)}` : "; no baseline yet"}`);
  }
  console.log(`  total about $${total.toFixed(3)}`);
  if (estimate) return 0;
  const limit = budget ?? suite.maxUsd;
  if (total > limit) {
    console.error(`the estimate is above $${limit}; pass --budget <usd> to allow it`);
    return 3;
  }
  const missing = missingVerifyTools(tasks);
  if (missing.length) {
    console.error(`verify tools missing: ${missing.join(", ")}`);
    return 3;
  }
  if (!update) for (const m of models) if (!baselines.get(m)) console.error(`${m} has no baseline: its results are recorded but not compared (make one with --update-baseline)`);
  if (args.length) process.env.CEDIA_EVAL_ARGS = JSON.stringify(args);

  const commit = gitHead() + (gitDirty() ? "-dirty" : "");
  const date = new Date().toISOString();
  let spent = 0;
  const verdicts: Comparison["verdict"][] = [];
  const reports: string[] = [];
  mkdirSync(resultsDir, { recursive: true });
  for (const m of models) {
    console.log(`\n${m}`);
    const run = await runAll(tasks, "cedia", m, { runs, jobs, budget: limit - spent });
    spent += run.spent;
    const out = join(resultsDir, `${date.slice(0, 10)}-${suite.name}-${slug(m)}-${commit}-${date.slice(11, 19).replaceAll(":", "")}.jsonl`);
    writeFileSync(out, run.results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(formatSummary(summarize(run.results)));
    console.log(`  results: ${out}`);

    const base = baselines.get(m);
    let verdict: Comparison["verdict"] = "inconclusive";
    if (base) {
      const c = compare(base.results, run.results, {
        thresholds: suite.thresholds,
        planned: tasks.length * runs,
        staleTasks: staleOf(base),
        sameJobs: base.jobs === jobs,
        model: m,
      });
      if (JSON.stringify(base.cediaArgs) !== JSON.stringify(args)) c.checks.unshift({ name: "setup", baseline: base.cediaArgs.join(" ") || "defaults", candidate: args.join(" ") || "defaults", status: "skipped", note: "cedia flags differ from the baseline's" });
      verdict = c.verdict;
      reports.push(formatComparison(c));
    } else reports.push(`${m}: NO BASELINE`);
    if (run.stopped) verdict = "inconclusive";
    verdicts.push(verdict);

    if (update) {
      if (run.stopped || run.results.filter((r) => !r.infraError).length < 0.8 * tasks.length * runs) {
        console.error(`  not stored as the baseline: the run stopped early or lost too many runs to provider errors`);
      } else {
        const b: Baseline = { suite: suite.name, model: m, commit, date, runs, jobs, cediaArgs: args, taskHashes: hashes, results: run.results.map((r) => ({ ...r, output: r.output.slice(-500), stderr: r.stderr.slice(-300) })) };
        mkdirSync(dirname(baselinePath(m, baselineDir)), { recursive: true });
        writeFileSync(baselinePath(m, baselineDir), JSON.stringify(b, null, 1) + "\n");
        console.log(`  baseline stored: ${baselinePath(m, baselineDir)}`);
      }
    }
  }
  console.log(`\nSpent $${spent.toFixed(4)}\n\n${reports.join("\n\n")}`);
  if (update) return 0;
  return verdicts.includes("regressed") ? 1 : verdicts.every((v) => v === "pass") ? 0 : 3;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
