#!/usr/bin/env bun
// Usage: bun evals/run.ts [--harness cedia|pi|claude|codex|opencode|omp] [--model <ref>] [--runs 3] [--jobs 4]
//                         [--tasks evals/tasks] [--only id,id] [--budget <usd>] [--estimate] [--out results.jsonl]
//
// Every harness binary comes from the environment (CEDIA_EVAL_<NAME>_BIN) or PATH, so the runner works on any
// machine. Each task runs `--runs` times, each in its own clean temp dir. The task's verify command decides
// pass or fail, never the agent's words.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { costUsd, resolveModel } from "../src/core/providers/catalog.ts";

export type Task = {
  id: string;
  category: string;
  prompt: string;
  setup?: Record<string, string>;
  verify?: string;
  expectedExitCode?: number;
  // Directory tasks only: a solution laid over setup, never copied into the workspace. The tests check that
  // setup alone fails verify and setup plus reference passes it.
  reference?: Record<string, string>;
};

type LedgerEntry = { kind: "rollout" | "session"; label: string; ms: number };

// What a harness reports about its own run, when it reports anything (cedia and claude print JSON).
export type Reported = {
  subtype?: string;
  costUsd?: number;
  tokens?: { input: number; cacheRead: number; output: number };
  cacheHitRatio?: number;
  turns?: number;
};

export type Result = {
  id: string;
  category: string;
  harness: string;
  model: string | null;
  run: number;
  ts: string;
  ledger: LedgerEntry[];
  wallMs: number;
  output: string;
  stderr: string;
  exitCode: number;
  reported: Reported;
  claimedDone: boolean;
  // cedia only: the done gate refused a claim, so the run did not claim done.
  refusedClaim: boolean;
  // The provider failed before the model produced anything (5xx after retries). Not the agent's result.
  infraError: boolean;
  attempts: number;
  verifyExitCode?: number;
  verifyOutput?: string;
  passed: boolean;
  falseDone: boolean;
  // Test files from the task that the agent changed; they are restored before verify.
  tampered?: string[];
};

type Invocation = { bin: string; args: string[]; env?: Record<string, string> };

const HARNESSES: Record<string, (task: Task, cwd: string, model: string | null) => Invocation> = {
  cedia: (task, _cwd, model) => ({
    bin: process.env.CEDIA_EVAL_CEDIA_BIN ?? resolve(import.meta.dir, "../bin/cedia"),
    args: [
      "-p", task.prompt,
      "--output-format", "json",
      "--permission", "workspace",
      "--max-budget-usd", process.env.CEDIA_EVAL_RUN_BUDGET ?? "0.5",
      ...(task.verify ? ["--check", task.verify] : []),
      ...(model ? ["--model", model] : []),
    ],
  }),
  pi: (task, _cwd, model) => ({ bin: process.env.CEDIA_EVAL_PI_BIN ?? "pi", args: ["-p", task.prompt, ...(model ? ["--model", model] : [])] }),
  claude: (task, _cwd, model) => ({
    bin: process.env.CEDIA_EVAL_CLAUDE_BIN ?? "claude",
    args: ["-p", task.prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Bash", ...(model ? ["--model", model] : [])],
  }),
  codex: (task) => ({ bin: process.env.CEDIA_EVAL_CODEX_BIN ?? "codex", args: ["exec", "--full-auto", task.prompt] }),
  opencode: (task, _cwd, model) => ({ bin: process.env.CEDIA_EVAL_OPENCODE_BIN ?? "opencode", args: ["run", task.prompt, ...(model ? ["--model", model] : [])] }),
  omp: (task, cwd, model) => ({ bin: process.env.CEDIA_EVAL_OMP_BIN ?? "omp", args: ["-p", task.prompt, "--cwd", cwd, ...(model ? ["--model", model] : [])] }),
};

export function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// Budget ledger (adapted from harness2 core/ledger.py, Apache-2.0).
// Per attempt: exactly 1 rollout (the harness run) + 1 session (the verify).
// Identity: R = P = attempts (runs plus declared reruns after provider errors). A row that breaks it means the runner
// retried, skipped, or double counted, and the summary must fail loudly.
export function checkLedgerIdentity(entries: LedgerEntry[], runCount: number): void {
  const rollouts = entries.filter((e) => e.kind === "rollout").length;
  const sessions = entries.filter((e) => e.kind === "session").length;
  if (rollouts !== runCount || sessions !== runCount) {
    throw new Error(`budget identity broken: R=${rollouts} (want ${runCount}), P=${sessions} (want ${runCount})`);
  }
}

// A rough signal for harnesses that do not say whether they claim done.
export const claimsDone = (stdout: string): boolean => /done|fixed|completed|passing|verified/i.test(stdout);

// Reads the JSON result cedia (`--output-format json`) or claude (`--output-format json`) prints last.
export function parseReported(stdout: string): { reported: Reported; text: string } | undefined {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (j.type !== "result") return undefined;
  const u = (j.usage ?? {}) as Record<string, number>;
  if ("costUsd" in j) {
    // cedia
    return {
      text: String(j.result ?? ""),
      reported: {
        subtype: String(j.subtype),
        costUsd: Number(j.costUsd),
        tokens: { input: (u.uncached ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), cacheRead: u.cacheRead ?? 0, output: u.output ?? 0 },
        cacheHitRatio: Number(j.cacheHitRatio),
        turns: Number(j.numTurns),
      },
    };
  }
  // claude -p
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return {
    text: String(j.result ?? ""),
    reported: {
      subtype: String(j.subtype),
      ...(typeof j.total_cost_usd === "number" ? { costUsd: j.total_cost_usd } : {}),
      tokens: { input, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
      ...(input ? { cacheHitRatio: (u.cache_read_input_tokens ?? 0) / input } : {}),
      ...(typeof j.num_turns === "number" ? { turns: j.num_turns } : {}),
    },
  };
}

function exec(bin: string, args: string[], cwd: string, timeoutMs: number, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: 127, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function runTask(task: Task, harness: string, model: string | null, run = 1): Promise<Result> {
  const make = HARNESSES[harness];
  if (!make) throw new Error(`unknown harness: ${harness}`);
  const cwd = mkdtempSync(join(tmpdir(), `cedia-eval-${task.id}-`));
  try {
    for (const [path, content] of Object.entries(task.setup ?? {})) {
      const full = join(cwd, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }

    const inv = make(task, cwd, model);
    const start = Date.now();
    const out = await exec(inv.bin, inv.args, cwd, 300_000, inv.env);
    const wallMs = Date.now() - start;
    const ledger: LedgerEntry[] = [{ kind: "rollout", label: `${task.id}#${run}:harness`, ms: wallMs }];
    const parsed = parseReported(out.stdout);
    const reported = parsed?.reported ?? {};
    const text = parsed?.text ?? out.stdout;
    // cedia's subtype says whether it claimed done; a refused claim (done gate) is not a claim.
    const refusedClaim = reported.subtype === "error_unverified_claim";
    const claimedDone = harness === "cedia" && parsed ? reported.subtype === "success" : claimsDone(text);
    const infraError = reported.subtype === "error_during_execution" && (reported.tokens?.input ?? 0) === 0;

    // Tests that came with the task are put back before verify, so editing them cannot pass the task.
    const tampered: string[] = [];
    for (const [path, content] of Object.entries(task.setup ?? {})) {
      if (!/\.test\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/.test(path)) continue;
      const full = join(cwd, path);
      if (existsSync(full) && readFileSync(full, "utf8") === content) continue;
      tampered.push(path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }

    const verifyStart = Date.now();
    let passed: boolean;
    let verifyExitCode: number | undefined;
    let verifyOutput: string | undefined;
    if (task.verify) {
      const argv = splitCommand(task.verify);
      const verify = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
      verifyExitCode = verify.status ?? 1;
      verifyOutput = ((verify.stdout ?? "") + (verify.stderr ?? "")).slice(-500);
      passed = verifyExitCode === (task.expectedExitCode ?? 0);
    } else {
      passed = out.code === 0;
    }
    ledger.push({ kind: "session", label: `${task.id}#${run}:verify`, ms: Date.now() - verifyStart });

    return {
      id: task.id,
      category: task.category,
      harness,
      model,
      run,
      ts: new Date().toISOString(),
      ledger,
      wallMs,
      output: text.slice(-2000),
      stderr: out.stderr.slice(-500),
      exitCode: out.code,
      reported,
      claimedDone,
      refusedClaim,
      infraError,
      attempts: 1,
      verifyExitCode,
      verifyOutput,
      passed,
      falseDone: claimedDone && !passed,
      ...(tampered.length ? { tampered } : {}),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// A task is either `<id>.json` (setup inline) or a directory `<id>/` holding task.json, files/ (the workspace)
// and reference/ (a solution, for the tests only).
export function loadTasks(dir: string): Task[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isFile() && e.name.endsWith(".json")) || (e.isDirectory() && existsSync(join(dir, e.name, "task.json"))))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      if (e.isFile()) return JSON.parse(readFileSync(join(dir, e.name), "utf8")) as Task;
      const root = join(dir, e.name);
      const task = JSON.parse(readFileSync(join(root, "task.json"), "utf8")) as Task;
      return { ...task, setup: { ...task.setup, ...readTree(join(root, "files")) }, reference: readTree(join(root, "reference")) };
    });
}

function readTree(root: string, prefix = ""): Record<string, string> {
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, readTree(root, rel));
    else out[rel] = readFileSync(join(root, rel), "utf8");
  }
  return out;
}

// A verify command whose tool is missing would fail every run for reasons that are not the agent's.
export function missingVerifyTools(tasks: Task[]): string[] {
  const missing = new Set<string>();
  for (const t of tasks) {
    if (!t.verify) continue;
    const [bin, ...rest] = splitCommand(t.verify);
    const probe = rest[0] === "-m" && rest[1] ? [bin!, "-c", `import ${rest[1]}`] : ["sh", "-c", `command -v ${bin}`];
    if (spawnSync(probe[0]!, probe.slice(1), { stdio: "ignore" }).status !== 0) missing.add(rest[0] === "-m" ? `${bin} -m ${rest[1]}` : bin!);
  }
  return [...missing];
}

export type Summary = {
  harness: string;
  model: string | null;
  tasks: number;
  runs: number;
  pass1: number; // mean pass rate over all runs
  passAll: number; // share of tasks that passed every run (pass^k)
  falseDone: number; // share of runs that claimed done and failed verify
  refused: number; // share of runs the done gate refused
  infraErrors: number; // runs left out because the provider failed before the model answered
  avgMs: number;
  costUsd?: number;
  costPerPass?: number;
  tokens?: { input: number; output: number };
  cacheHitRatio?: number;
};

export function summarize(all: Result[]): Summary {
  const results = all.filter((r) => !r.infraError);
  const byTask = new Map<string, Result[]>();
  for (const r of results) byTask.set(r.id, [...(byTask.get(r.id) ?? []), r]);
  const n = results.length;
  const passes = results.filter((r) => r.passed).length;
  const costs = results.map((r) => r.reported.costUsd).filter((c): c is number => typeof c === "number");
  const tok = results.map((r) => r.reported.tokens).filter((t) => t !== undefined);
  const input = tok.reduce((a, t) => a + t!.input, 0);
  const cacheRead = tok.reduce((a, t) => a + t!.cacheRead, 0);
  const costUsd = costs.length ? costs.reduce((a, c) => a + c, 0) : undefined;
  return {
    harness: results[0]?.harness ?? "",
    model: results[0]?.model ?? null,
    tasks: byTask.size,
    runs: n,
    pass1: n ? passes / n : 0,
    passAll: byTask.size ? [...byTask.values()].filter((rs) => rs.every((r) => r.passed)).length / byTask.size : 0,
    falseDone: n ? results.filter((r) => r.falseDone).length / n : 0,
    refused: n ? results.filter((r) => r.refusedClaim).length / n : 0,
    infraErrors: all.length - n,
    avgMs: n ? Math.round(results.reduce((a, r) => a + r.wallMs, 0) / n) : 0,
    ...(costUsd !== undefined ? { costUsd, ...(passes ? { costPerPass: costUsd / passes } : {}) } : {}),
    ...(tok.length ? { tokens: { input, output: tok.reduce((a, t) => a + t!.output, 0) }, cacheHitRatio: input ? cacheRead / input : 0 } : {}),
  };
}

// Projects the cost of a run from measured tokens: per-run mean input, cache share and output of an earlier
// result file, priced at the target model. Without measurements it uses a conservative default.
export function estimateCost(modelRef: string, runs: number, measured?: Result[]): { usd: number; basis: string } {
  const model = resolveModel(modelRef);
  const tok = measured?.map((r) => r.reported.tokens).filter((t) => t !== undefined) ?? [];
  const per = tok.length
    ? { input: tok.reduce((a, t) => a + t!.input, 0) / tok.length, cacheRead: tok.reduce((a, t) => a + t!.cacheRead, 0) / tok.length, output: tok.reduce((a, t) => a + t!.output, 0) / tok.length }
    : { input: 60_000, cacheRead: 50_000, output: 3_000 };
  // Priced as if every uncached token were a cache write: the dearer reading on Anthropic, equal elsewhere.
  const usdPerRun = costUsd(model, { uncached: 0, cacheWrite: per.input - per.cacheRead, cacheRead: per.cacheRead, output: per.output });
  return { usd: usdPerRun * runs, basis: tok.length ? `measured mean of ${tok.length} runs` : "default 60k input (50k cached), 3k output per run" };
}

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

export function formatSummary(s: Summary): string {
  return [
    `${s.harness}${s.model ? ` (${s.model})` : ""}: ${s.tasks} tasks, ${s.runs} scored runs${s.infraErrors ? `, ${s.infraErrors} left out for provider errors` : ""}`,
    `  pass@1 ${pct(s.pass1)}  pass^k ${pct(s.passAll)}  false-done ${pct(s.falseDone)}  refused claims ${pct(s.refused)}`,
    `  avg ${(s.avgMs / 1000).toFixed(1)}s per run` +
      (s.tokens ? `, ${Math.round(s.tokens.input / s.runs)} input / ${Math.round(s.tokens.output / s.runs)} output tokens per run, cache hit ${pct(s.cacheHitRatio ?? 0)}` : ""),
    s.costUsd !== undefined ? `  cost $${s.costUsd.toFixed(4)} total, ${s.costPerPass !== undefined ? `$${s.costPerPass.toFixed(4)} per passed run` : "no passes"}` : "  cost not reported",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  let harness = "cedia";
  let tasksDir = resolve(import.meta.dir, "tasks");
  let model: string | null = process.env.CEDIA_MODEL ?? null;
  let outPath = "results.jsonl";
  let runs = 3;
  let jobs = 4;
  let budget = Infinity;
  let only: string[] | undefined;
  let estimate = false;
  let measuredPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--harness") harness = argv[++i]!;
    else if (a === "--tasks") tasksDir = argv[++i]!;
    else if (a === "--out") outPath = argv[++i]!;
    else if (a === "--model") model = argv[++i]!;
    else if (a === "--runs") runs = Number(argv[++i]);
    else if (a === "--jobs") jobs = Number(argv[++i]);
    else if (a === "--budget") budget = Number(argv[++i]);
    else if (a === "--only") only = argv[++i]!.split(",");
    else if (a === "--estimate") estimate = true;
    else if (a === "--measured") measuredPath = argv[++i]!;
  }

  const tasks = loadTasks(tasksDir).filter((t) => !only || only.includes(t.id));
  const total = tasks.length * runs;
  if (estimate) {
    if (!model) throw new Error("--estimate needs --model");
    const measured = measuredPath ? readFileSync(measuredPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Result) : undefined;
    const e = estimateCost(model, total, measured);
    console.log(`${tasks.length} tasks x ${runs} runs on ${model}: about $${e.usd.toFixed(4)} (${e.basis})`);
    return 0;
  }
  const missing = missingVerifyTools(tasks);
  if (missing.length) {
    console.error(`verify tools missing: ${missing.join(", ")}. Install them first; otherwise those tasks fail for reasons that are not the agent's.`);
    return 2;
  }

  console.log(`Running ${tasks.length} tasks x ${runs} runs on ${harness}${model ? ` (${model})` : ""}, ${jobs} at a time...`);
  const queue = tasks.flatMap((task) => Array.from({ length: runs }, (_, k) => ({ task, run: k + 1 })));
  const results: Result[] = [];
  let spent = 0;
  let stopped = false;
  const worker = async () => {
    while (queue.length && !stopped) {
      const { task, run } = queue.shift()!;
      const r = await runTask(task, harness, model, run);
      results.push(r);
      spent += r.reported.costUsd ?? 0;
      const cost = r.reported.costUsd !== undefined ? ` $${r.reported.costUsd.toFixed(4)}` : "";
      console.log(`  ${r.passed ? "PASS" : "FAIL"} ${task.id}#${run} (${(r.wallMs / 1000).toFixed(1)}s${cost}${r.falseDone ? ", FALSE DONE" : ""}${r.refusedClaim ? ", claim refused" : ""})`);
      if (spent >= budget && !stopped) {
        stopped = true;
        console.error(`budget $${budget} reached after $${spent.toFixed(4)}; stopping`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, total)) }, worker));
  // A provider outage is not the agent's result: rerun those once, one at a time, and keep both attempts in the ledger.
  for (const [i, r] of results.entries()) {
    if (!r.infraError || stopped) continue;
    const task = tasks.find((t) => t.id === r.id)!;
    const again = await runTask(task, harness, model, r.run);
    results[i] = { ...again, attempts: r.attempts + 1, ledger: [...r.ledger, ...again.ledger] };
    spent += again.reported.costUsd ?? 0;
    console.log(`  ${again.passed ? "PASS" : "FAIL"} ${task.id}#${r.run} (rerun after a provider error${again.infraError ? ", provider error again" : ""})`);
  }

  results.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);
  writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nResults written to ${outPath}`);
  checkLedgerIdentity(results.flatMap((r) => r.ledger), results.reduce((a, r) => a + r.attempts, 0));
  console.log(formatSummary(summarize(results)));
  return stopped ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
