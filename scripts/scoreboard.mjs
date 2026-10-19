#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Usage: node scripts/scoreboard.mjs [--harness cedia|pi] [--tasks tasks/] [--out results.jsonl]

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
let harness = "cedia";
let tasksDir = "tasks";
let model = process.env.CEDIA_MODEL || null;
let outPath = "results.jsonl";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--harness") harness = args[++i];
  else if (args[i] === "--tasks") tasksDir = args[++i];
  else if (args[i] === "--out") outPath = args[++i];
  else if (args[i] === "--model") model = args[++i];
}

if (harness === "cedia" && !process.env.ANTHROPIC_API_KEY && !model) {
  console.warn("WARNING: ANTHROPIC_API_KEY not set. cedia will fail to run tasks.");
  console.warn("Set ANTHROPIC_API_KEY or use --model with a provider that has credentials.");
}
const CEDIA_BIN = resolve(process.cwd(), "bin/cedia");
const PI_BIN = "/Users/pond/cedia-cli/node_modules/.bin/pi";
const CLAUDE_BIN = "claude";
const OPENCODE_BIN = "opencode";

function runCommand(cmd, cwd, timeout = 120000) {
  const start = Date.now();
  try {
    const result = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1, ms: Date.now() - start, timedOut: result.signal === "SIGTERM" };
  } catch (e) {
    return { stdout: "", stderr: e.message, exitCode: 1, ms: Date.now() - start, timedOut: false };
  }
}

// Budget ledger (adapted from harness2 core/ledger.py, Apache-2.0).
// Per task: exactly 1 rollout (the harness run) + 1 session (the verify).
// Identity: R = N tasks, P = N tasks. A row that breaks it means the runner
// retried, skipped, or double counted, and the summary must fail loudly.
function ledgerEntry(kind, label, ms) {
  return { kind, label, ms };
}

function checkLedgerIdentity(entries, taskCount) {
  const rollouts = entries.filter((e) => e.kind === "rollout").length;
  const sessions = entries.filter((e) => e.kind === "session").length;
  if (rollouts !== taskCount || sessions !== taskCount) {
    throw new Error(`budget identity broken: R=${rollouts} (want ${taskCount}), P=${sessions} (want ${taskCount})`);
  }
}

function runTask(task, h) {
  const cwd = mkdtempSync(join(tmpdir(), `scoreboard-${task.id}-`));
  const result = { id: task.id, category: task.category, harness: h, ts: new Date().toISOString(), ledger: [] };

  // Setup workspace
  if (task.setup) {
    for (const [path, content] of Object.entries(task.setup)) {
      const full = join(cwd, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
  }

  // Run harness
  let bin, cmdArgs, env;
  if (h === "cedia") {
    bin = CEDIA_BIN;
    env = { ...process.env };
    cmdArgs = ["-p", task.prompt];
    if (model) cmdArgs.push("--model", model);
  } else if (h === "claude") {
    bin = CLAUDE_BIN;
    env = { ...process.env };
    cmdArgs = ["-p", task.prompt];
  } else if (h === "opencode") {
    bin = OPENCODE_BIN;
    env = { ...process.env };
    cmdArgs = ["run", task.prompt];
    if (model) cmdArgs.push("--model", model);
  } else {
    bin = PI_BIN;
    env = { ...process.env, PI_CODING_AGENT_DIR: process.env.HOME + "/.pi/agent" };
    cmdArgs = ["-p", task.prompt];
    if (model) cmdArgs.push("--model", model);
  }
  const prompt = task.prompt;
  const start = Date.now();
  const run = spawnSync(bin, cmdArgs, { cwd, encoding: "utf8", timeout: 300000, env, stdio: ["ignore", "pipe", "pipe"] });
  result.wallMs = Date.now() - start;
  result.ledger.push(ledgerEntry("rollout", `${task.id}:harness`, result.wallMs));
  result.output = (run.stdout ?? "").slice(-2000);
  result.stderr = (run.stderr ?? "").slice(-500);
  result.exitCode = run.status ?? 1;

  // Check if agent claimed done
  const claimedDone = /done|fixed|completed|passing|verified/i.test(run.stdout ?? "");
  result.claimedDone = claimedDone;

  // Run verification
  const verifyStart = Date.now();
  if (task.verify) {
    const verify = runCommand(task.verify.split(" "), cwd);
    result.verifyExitCode = verify.exitCode;
    result.verifyOutput = verify.stdout.slice(-500);
    result.passed = verify.exitCode === (task.expectedExitCode ?? 0);
  } else {
    result.passed = run.status === 0;
  }
  result.ledger.push(ledgerEntry("session", `${task.id}:verify`, Date.now() - verifyStart));

  // False-done: claimed done but verify failed
  result.falseDone = claimedDone && !result.passed;

  // Cleanup
  try { rmSync(cwd, { recursive: true, force: true }); } catch {}

  return result;
}

// Load tasks
const taskFiles = readdirSync(tasksDir).filter((f) => f.endsWith(".json"));
const tasks = taskFiles.map((f) => JSON.parse(readFileSync(join(tasksDir, f), "utf8")));

console.log(`Running ${tasks.length} tasks on ${harness}...`);

const results = [];
for (const task of tasks) {
  console.log(`  ${task.id} (${task.category})...`);
  const r = runTask(task, harness);
  results.push(r);
  console.log(`    ${r.passed ? "PASS" : "FAIL"} (claimed done: ${r.claimedDone}, false-done: ${r.falseDone}, ${r.wallMs}ms)`);
}

// Write results
const out = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(outPath, out);
console.log(`\nResults written to ${outPath}`);

// Budget identity: one rollout + one verify session per task.
checkLedgerIdentity(results.flatMap((r) => r.ledger ?? []), results.length);

// Summary
const passed = results.filter((r) => r.passed).length;
const falseDones = results.filter((r) => r.falseDone).length;
console.log(`Pass rate: ${passed}/${results.length} (${Math.round(passed / results.length * 100)}%)`);
console.log(`False-done rate: ${falseDones}/${results.length}`);
console.log(`Avg wall time: ${Math.round(results.reduce((a, r) => a + r.wallMs, 0) / results.length)}ms`);