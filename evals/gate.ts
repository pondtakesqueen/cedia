#!/usr/bin/env bun
// Usage: bun evals/gate.ts [--suite evals/gate/suite.json] [--model <ref>]... [--runs <n>] [--jobs <n>] [--budget <usd>]
//                          [--estimate] [--update-baseline [--allow-dirty] [--accept-regression]] [--only id,id]
//                          [--cedia-arg=<flag>]...
//        bun evals/gate.ts --compare <results.jsonl> [--against <results.jsonl|baseline.json>]
//
// The regression gate. Runs the suite's tasks on each model, records pass rate, false-done, cost and time, and
// compares them with the baseline stored for that model in evals/gate/baseline/. Exit 0 when no model got worse,
// 1 when one regressed, 3 when the comparison cannot be made (no baseline, too many provider errors, budget hit).
// It prints the expected cost from the baseline's own spend (or earlier results) before it starts, and refuses to
// start a run that would cost more than the suite's maxUsd unless --budget allows it.
//
// --only runs some of the suite's tasks; with --update-baseline it replaces only their rows, as after a task changed.
// --update-baseline refuses a tree with uncommitted changes (--allow-dirty) and a run that regressed against the
// baseline it would replace (--accept-regression, for a PR that says why the new numbers are the right ones).
// --compare scores an existing result file instead of running anything, so a rule change can be checked for free.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ALIASES, CATALOG } from "../src/core/providers/catalog.ts";
import { estimateCost, formatSummary, loadTasks, missingVerifyTools, providerFailed, REPO_ROOT, runAll, summarize, type Result, type Task } from "./run.ts";

export type Thresholds = {
  // One-sided Fisher exact test on passed runs: a lower pass rate fails the gate when p is below this.
  passP: number;
  // Cost or wall time of the typical task (geometric mean of per-task ratios) may rise by this share.
  costRise: number;
  timeRise: number;
  // The whole task set's cost or wall time (sum of per-task means) may rise by this share.
  totalRise: number;
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
  // Relative to the suite file; evals/gate/baseline by default. A second suite keeps its baselines apart, since a
  // baseline file is named by model only.
  baselineDir?: string;
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

// Paired by task, so a run that lost a task to provider errors is not cheaper for it. `base` and `cand` are the sums
// over common tasks of each task's mean; `typical` is the geometric mean of the per-task ratios, which one noisy
// expensive task cannot move much.
function paired(base: Map<string, Result[]>, cand: Map<string, Result[]>, f: (r: Result) => number | undefined): { base: number; cand: number; typical?: number } | undefined {
  let b = 0;
  let c = 0;
  const logs: number[] = [];
  for (const [id, crs] of cand) {
    const bv = (base.get(id) ?? []).map(f).filter((x): x is number => typeof x === "number");
    const cv = crs.map(f).filter((x): x is number => typeof x === "number");
    if (!bv.length || !cv.length) continue;
    b += mean(bv);
    c += mean(cv);
    if (mean(bv) > 0 && mean(cv) > 0) logs.push(Math.log(mean(cv) / mean(bv)));
  }
  return b || c ? { base: b, cand: c, ...(logs.length ? { typical: Math.exp(mean(logs)) } : {}) } : undefined;
}

// A model whose price changes with the hour (DeepSeek's off-peak discount) is compared at its standard price,
// re-priced from each run's tokens: otherwise a gate run at peak hours fails against an off-peak baseline on price
// alone (Flash: +63% reported, +3% at one price, on 2026-10-22). Undefined for any other model.
export function listCost(model: string): ((r: Result) => number | undefined) | undefined {
  const m = CATALOG.find((c) => c.ref === (ALIASES[model] ?? model));
  if (!m?.price.offPeak) return undefined;
  const pr = m.price;
  return (r) => {
    const t = r.reported.tokens;
    if (!t) return r.reported.costUsd;
    return ((t.input - t.cacheRead) * pr.input + t.cacheRead * pr.cacheRead + t.output * pr.output) / 1_000_000;
  };
}

export function compare(
  baseAll: Result[],
  candAll: Result[],
  opts: { thresholds: Thresholds; planned?: number; staleTasks?: string[]; sameJobs?: boolean; model?: string; hiddenTasks?: string[] },
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

  // A false done is the trust guarantee failing, so any rise fails the gate. On a task with hidden tests the run's
  // own checks passed and the spec it could not see failed: that is a failed run, already counted above.
  const hidden = new Set(opts.hiddenTasks ?? []);
  const seen = (rs: Result[]) => rs.filter((r) => !hidden.has(r.id));
  const fd = (rs: Result[]) => ({ n: seen(rs).length, f: seen(rs).filter((r) => r.falseDone).length, h: rs.filter((r) => r.falseDone && hidden.has(r.id)).length });
  const bf = fd(base);
  const cf = fd(cand);
  const rate = (x: { n: number; f: number }) => (x.n ? x.f / x.n : 0);
  checks.push({
    name: "false-done",
    baseline: `${pct(rate(bf))} (${bf.f})`,
    candidate: `${pct(rate(cf))} (${cf.f})`,
    status: rate(cf) > rate(bf) ? "regressed" : rate(cf) < rate(bf) ? "better" : "ok",
    ...(bf.h || cf.h ? { note: `plus ${bf.h} -> ${cf.h} on tasks with hidden tests, counted as failures, not gated here` } : {}),
  });

  // Two limits each: the typical task (geometric mean of per-task ratios) and the whole set (sum of task means), so
  // neither a broad small rise nor a large one on one expensive task gets through. `floor` is the smallest absolute
  // rise of the set that counts, so tasks of a few seconds cannot fail the gate on jitter.
  const rise = (name: string, f: (r: Result) => number | undefined, limit: number, floor: number, fmt: (x: number) => string, skip?: string) => {
    const r = paired(bt, ct, f);
    if (skip || !r) return checks.push({ name, baseline: r ? fmt(r.base) : "-", candidate: r ? fmt(r.cand) : "-", status: "skipped", note: skip ?? "not reported" });
    if (r.base < 1e-9) return checks.push({ name, baseline: fmt(r.base), candidate: fmt(r.cand), status: "skipped", note: "the baseline costs nothing" });
    const total = r.cand / r.base;
    const typical = r.typical ?? total;
    const signed = (x: number) => `${x >= 1 ? "+" : ""}${pct(x - 1)}`;
    const over = r.cand - r.base > floor && (typical > 1 + limit || total > 1 + th.totalRise);
    const under = r.base - r.cand > floor && typical < 1 - limit && total < 1;
    checks.push({
      name,
      baseline: fmt(r.base),
      candidate: fmt(r.cand),
      status: over ? "regressed" : under ? "better" : "ok",
      note: `typical task ${signed(typical)} (limit +${pct(limit)}), whole set ${signed(total)} (limit +${pct(th.totalRise)})`,
    });
  };
  const listed = listCost(model);
  rise("cost", listed ?? ((r) => r.reported.costUsd), th.costRise, 0.002, (x) => `$${x.toFixed(4)}`);
  if (listed) checks.at(-1)!.note += "; at the standard price, since this model's off-peak discount depends on the hour a run happened to start";
  rise("time", (r) => r.wallMs, th.timeRise, 10_000, (x) => `${(x / 1000).toFixed(0)}s`, opts.sameJobs === false ? "the baseline ran at another --jobs, which changes wall time" : undefined);
  // Reported, never gated: they explain a cost or time change.
  const nTasks = ct.size;
  const turns = paired(bt, ct, (r) => r.reported.turns);
  if (turns) checks.push({ name: "turns", baseline: turns.base.toFixed(0), candidate: turns.cand.toFixed(0), status: "ok", note: `${nTasks} tasks, not gated` });

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

// Rows written before a provider failure was recognized are judged again by today's rule.
const readRows = (path: string): Result[] =>
  readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    const r = JSON.parse(l) as Result;
    return { ...r, infraError: r.infraError || providerFailed(r.reported?.subtype, r.reported?.tokens?.input ?? 0, r.output ?? "") };
  });

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
// Results and baselines are what the gate writes, not the code it measures.
const gitDirty = () =>
  Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no", "--", ".", ":!evals/results", ":!evals/gate/baseline"], { cwd: REPO_ROOT }).stdout.toString().trim() !== "";

const DIRTY = "the tree has uncommitted changes; commit them first (or pass --allow-dirty)";

// Why a run must not become the baseline, or undefined when it may. A baseline judges every later change, so it is
// made from a commit that can be checked out again, and never from a run the gate itself just failed: on 2026-10-27
// the Claude API baseline was overwritten from an uncommitted tree by a run that had REGRESSED.
export function baselineRefusal(r: { dirty: boolean; allowDirty: boolean; verdict: Comparison["verdict"]; acceptRegression: boolean; stopped: boolean; scored: number; planned: number }): string | undefined {
  if (r.dirty && !r.allowDirty) return DIRTY;
  if (r.stopped || r.scored < 0.8 * r.planned) return "the run stopped early or lost too many runs to provider errors";
  if (r.verdict === "regressed" && !r.acceptRegression) return "the run regressed against the baseline it would replace (pass --accept-regression and say why in the PR)";
  return undefined;
}

async function main(argv: string[]): Promise<number> {
  let suitePath = DEFAULT_SUITE;
  let baselineDir: string | undefined;
  let resultsDir = resolve(import.meta.dir, "results");
  const models: string[] = [];
  let runs: number | undefined;
  let jobs: number | undefined;
  let budget: number | undefined;
  let estimate = false;
  let update = false;
  let allowDirty = false;
  let acceptRegression = false;
  let comparePath: string | undefined;
  let againstPath: string | undefined;
  let only: string[] | undefined;
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
    else if (a === "--allow-dirty") allowDirty = true;
    else if (a === "--accept-regression") acceptRegression = true;
    else if (a === "--compare") comparePath = argv[++i]!;
    else if (a === "--against") againstPath = argv[++i]!;
    else if (a === "--only") only = argv[++i]!.split(",");
    else if (a === "--cedia-arg" || a.startsWith("--cedia-arg=")) cediaArgs.push(a.includes("=") ? a.slice("--cedia-arg=".length) : argv[++i]!);
    else throw new Error(`unknown flag: ${a}`);
  }
  const loaded = loadSuite(suitePath);
  const { suite } = loaded;
  baselineDir ??= suite.baselineDir ? resolve(dirname(suitePath), suite.baselineDir) : BASELINE_DIR;
  for (const id of only ?? []) if (!suite.tasks.includes(id)) throw new Error(`--only: ${id} is not in suite ${suite.name}`);
  const tasks = loaded.tasks.filter((t) => !only || only.includes(t.id));
  const hiddenTasks = tasks.filter((t) => Object.keys(t.hidden ?? {}).length).map((t) => t.id);
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
    const c = compare(base.results, cand, { thresholds: suite.thresholds, staleTasks: staleOf(base), model, hiddenTasks });
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

  const dirty = gitDirty();
  // Refused before anything is spent; the other reasons can only be known after the run.
  if (update && dirty && !allowDirty) {
    console.error(`not run: ${DIRTY}`);
    return 3;
  }
  const commit = gitHead() + (dirty ? "-dirty" : "");
  const date = new Date().toISOString();
  let spent = 0;
  const verdicts: Comparison["verdict"][] = [];
  const reports: string[] = [];
  let refused = false;
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
        hiddenTasks,
      });
      if (JSON.stringify(base.cediaArgs) !== JSON.stringify(args)) c.checks.unshift({ name: "setup", baseline: base.cediaArgs.join(" ") || "defaults", candidate: args.join(" ") || "defaults", status: "skipped", note: "cedia flags differ from the baseline's" });
      verdict = c.verdict;
      reports.push(formatComparison(c));
    } else reports.push(`${m}: NO BASELINE`);
    if (run.stopped) verdict = "inconclusive";
    verdicts.push(verdict);

    if (update) {
      const why = baselineRefusal({ dirty, allowDirty, verdict, acceptRegression, stopped: run.stopped, scored: run.results.filter((r) => !r.infraError).length, planned: tasks.length * runs });
      if (why) {
        refused = true;
        console.error(`  not stored as the baseline: ${why}`);
      } else {
        const rows = run.results.map((r) => ({ ...r, output: r.output.slice(-500), stderr: r.stderr.slice(-300) }));
        // With --only, the other tasks keep their baseline rows; the record of how it was made is the new run's.
        const kept = only && base ? base.results.filter((r) => !only!.includes(r.id)) : [];
        const b: Baseline = {
          suite: suite.name, model: m, commit, date, runs, jobs, cediaArgs: args,
          taskHashes: { ...(only && base ? base.taskHashes : {}), ...hashes },
          results: [...kept, ...rows].sort((x, y) => x.id.localeCompare(y.id) || x.run - y.run),
        };
        mkdirSync(dirname(baselinePath(m, baselineDir)), { recursive: true });
        writeFileSync(baselinePath(m, baselineDir), JSON.stringify(b, null, 1) + "\n");
        console.log(`  baseline stored: ${baselinePath(m, baselineDir)}`);
      }
    }
  }
  console.log(`\nSpent $${spent.toFixed(4)}\n\n${reports.join("\n\n")}`);
  if (update) return refused ? (verdicts.includes("regressed") ? 1 : 3) : 0;
  return verdicts.includes("regressed") ? 1 : verdicts.every((v) => v === "pass") ? 0 : 3;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
