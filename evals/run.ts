#!/usr/bin/env bun
// Usage: bun evals/run.ts [--harness cedia|pi|claude|codex|opencode|omp] [--tasks evals/tasks] [--model <ref>] [--out results.jsonl]
//
// Every harness binary comes from the environment (CEDIA_EVAL_<NAME>_BIN) or PATH,
// so the runner works on any machine.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Task = {
  id: string;
  category: string;
  prompt: string;
  setup?: Record<string, string>;
  verify?: string;
  expectedExitCode?: number;
};

type LedgerEntry = { kind: "rollout" | "session"; label: string; ms: number };

export type Result = {
  id: string;
  category: string;
  harness: string;
  model: string | null;
  ts: string;
  ledger: LedgerEntry[];
  wallMs: number;
  output: string;
  stderr: string;
  exitCode: number;
  claimedDone: boolean;
  verifyExitCode?: number;
  verifyOutput?: string;
  passed: boolean;
  falseDone: boolean;
};

type Invocation = { bin: string; args: string[]; env?: Record<string, string> };

const HARNESSES: Record<string, (prompt: string, cwd: string, model: string | null) => Invocation> = {
  cedia: (prompt, _cwd, model) => ({
    bin: process.env.CEDIA_EVAL_CEDIA_BIN ?? resolve(import.meta.dir, "../bin/cedia"),
    args: ["-p", prompt, ...(model ? ["--model", model] : [])],
  }),
  pi: (prompt, _cwd, model) => ({
    bin: process.env.CEDIA_EVAL_PI_BIN ?? "pi",
    args: ["-p", prompt, ...(model ? ["--model", model] : [])],
  }),
  claude: (prompt) => ({ bin: process.env.CEDIA_EVAL_CLAUDE_BIN ?? "claude", args: ["-p", prompt] }),
  codex: (prompt) => ({ bin: process.env.CEDIA_EVAL_CODEX_BIN ?? "codex", args: ["exec", prompt] }),
  opencode: (prompt, _cwd, model) => ({
    bin: process.env.CEDIA_EVAL_OPENCODE_BIN ?? "opencode",
    args: ["run", prompt, ...(model ? ["--model", model] : [])],
  }),
  omp: (prompt, cwd, model) => ({
    bin: process.env.CEDIA_EVAL_OMP_BIN ?? "omp",
    args: ["-p", prompt, "--cwd", cwd, ...(model ? ["--model", model] : [])],
  }),
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
// Per task: exactly 1 rollout (the harness run) + 1 session (the verify).
// Identity: R = N tasks, P = N tasks. A row that breaks it means the runner
// retried, skipped, or double counted, and the summary must fail loudly.
export function checkLedgerIdentity(entries: LedgerEntry[], taskCount: number): void {
  const rollouts = entries.filter((e) => e.kind === "rollout").length;
  const sessions = entries.filter((e) => e.kind === "session").length;
  if (rollouts !== taskCount || sessions !== taskCount) {
    throw new Error(`budget identity broken: R=${rollouts} (want ${taskCount}), P=${sessions} (want ${taskCount})`);
  }
}

// A rough signal only; the trust ledger in core replaces it once cedia records claims itself.
export const claimsDone = (stdout: string): boolean => /done|fixed|completed|passing|verified/i.test(stdout);

export function runTask(task: Task, harness: string, model: string | null): Result {
  const make = HARNESSES[harness];
  if (!make) throw new Error(`unknown harness: ${harness}`);
  const cwd = mkdtempSync(join(tmpdir(), `cedia-eval-${task.id}-`));
  try {
    for (const [path, content] of Object.entries(task.setup ?? {})) {
      const full = join(cwd, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }

    const inv = make(task.prompt, cwd, model);
    const start = Date.now();
    const run = spawnSync(inv.bin, inv.args, {
      cwd,
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, ...inv.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const wallMs = Date.now() - start;
    const ledger: LedgerEntry[] = [{ kind: "rollout", label: `${task.id}:harness`, ms: wallMs }];
    const stdout = run.stdout ?? "";
    const exitCode = run.status ?? 1;
    const claimedDone = claimsDone(stdout);

    const verifyStart = Date.now();
    let passed: boolean;
    let verifyExitCode: number | undefined;
    let verifyOutput: string | undefined;
    if (task.verify) {
      const argv = splitCommand(task.verify);
      const verify = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
      verifyExitCode = verify.status ?? 1;
      verifyOutput = (verify.stdout ?? "").slice(-500);
      passed = verifyExitCode === (task.expectedExitCode ?? 0);
    } else {
      passed = exitCode === 0;
    }
    ledger.push({ kind: "session", label: `${task.id}:verify`, ms: Date.now() - verifyStart });

    return {
      id: task.id,
      category: task.category,
      harness,
      model,
      ts: new Date().toISOString(),
      ledger,
      wallMs,
      output: stdout.slice(-2000),
      stderr: (run.stderr ?? (run.error ? String(run.error) : "")).slice(-500),
      exitCode,
      claimedDone,
      verifyExitCode,
      verifyOutput,
      passed,
      falseDone: claimedDone && !passed,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function loadTasks(dir: string): Task[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Task);
}

function main(argv: string[]): void {
  let harness = "cedia";
  let tasksDir = resolve(import.meta.dir, "tasks");
  let model: string | null = process.env.CEDIA_MODEL ?? null;
  let outPath = "results.jsonl";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--harness") harness = argv[++i]!;
    else if (argv[i] === "--tasks") tasksDir = argv[++i]!;
    else if (argv[i] === "--out") outPath = argv[++i]!;
    else if (argv[i] === "--model") model = argv[++i]!;
  }

  const tasks = loadTasks(tasksDir);
  console.log(`Running ${tasks.length} tasks on ${harness}${model ? ` (${model})` : ""}...`);
  const results: Result[] = [];
  for (const task of tasks) {
    console.log(`  ${task.id} (${task.category})...`);
    const r = runTask(task, harness, model);
    results.push(r);
    console.log(`    ${r.passed ? "PASS" : "FAIL"} (claimed done: ${r.claimedDone}, false-done: ${r.falseDone}, ${r.wallMs}ms)`);
  }

  writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nResults written to ${outPath}`);
  checkLedgerIdentity(results.flatMap((r) => r.ledger), results.length);

  const passed = results.filter((r) => r.passed).length;
  const falseDones = results.filter((r) => r.falseDone).length;
  console.log(`Pass rate: ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%)`);
  console.log(`False-done rate: ${falseDones}/${results.length}`);
  console.log(`Avg wall time: ${Math.round(results.reduce((a, r) => a + r.wallMs, 0) / results.length)}ms`);
}

if (import.meta.main) main(process.argv.slice(2));
