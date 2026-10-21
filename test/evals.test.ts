import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLedgerIdentity, claimsDone, estimateCost, loadTasks, parseReported, runTask, splitCommand, summarize, type Result, type Task } from "../evals/run.ts";

describe("evals runner", () => {
  test("splitCommand keeps quoted arguments together", () => {
    expect(splitCommand(`node -e "console.log('a b')" x`)).toEqual(["node", "-e", "console.log('a b')", "x"]);
  });

  test("ledger identity holds for one rollout and one verify per run", () => {
    const entries = [
      { kind: "rollout" as const, label: "a:harness", ms: 1 },
      { kind: "session" as const, label: "a:verify", ms: 1 },
    ];
    expect(() => checkLedgerIdentity(entries, 1)).not.toThrow();
    expect(() => checkLedgerIdentity([...entries, entries[0]!], 1)).toThrow(/budget identity broken/);
  });

  test("claimsDone is a keyword signal", () => {
    expect(claimsDone("All tests passing.")).toBe(true);
    expect(claimsDone("I could not finish.")).toBe(false);
  });

  test("every task file has an id, a prompt and a verify command", () => {
    const tasks = loadTasks(new URL("../evals/tasks", import.meta.url).pathname);
    expect(tasks.length).toBe(12);
    for (const t of tasks) {
      expect(t.id).toBeTruthy();
      expect(t.prompt).toBeTruthy();
      expect(t.verify).toBeTruthy();
    }
  });

  test("parses cedia's and claude's JSON results", () => {
    const cedia = parseReported('noise\n{"type":"result","subtype":"success","costUsd":0.01,"cacheHitRatio":0.9,"numTurns":4,"result":"ok","usage":{"uncached":100,"cacheRead":900,"cacheWrite":0,"output":50}}\n');
    expect(cedia).toEqual({ text: "ok", reported: { subtype: "success", costUsd: 0.01, tokens: { input: 1000, cacheRead: 900, output: 50 }, cacheHitRatio: 0.9, turns: 4 } });
    const claude = parseReported('{"type":"result","subtype":"success","total_cost_usd":0.2,"num_turns":3,"result":"done","usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":10,"output_tokens":7}}');
    expect(claude?.reported).toEqual({ subtype: "success", costUsd: 0.2, tokens: { input: 100, cacheRead: 80, output: 7 }, cacheHitRatio: 0.8, turns: 3 });
    expect(parseReported("plain text")).toBeUndefined();
  });

  test("summarize computes pass@1, pass^k, false-done and cost per passed run", () => {
    const r = (id: string, run: number, passed: boolean, claimed: boolean, cost: number): Result =>
      ({ id, category: "c", harness: "cedia", model: "m", run, ts: "", ledger: [], wallMs: 1000, output: "", stderr: "", exitCode: 0,
        reported: { costUsd: cost, tokens: { input: 1000, cacheRead: 900, output: 10 } }, claimedDone: claimed, refusedClaim: !claimed, infraError: false, attempts: 1, passed, falseDone: claimed && !passed });
    const outage = { ...r("b", 3, false, false, 0), infraError: true };
    const s = summarize([r("a", 1, true, true, 0.01), r("a", 2, true, true, 0.01), r("b", 1, true, true, 0.01), r("b", 2, false, true, 0.01), outage]);
    expect(s).toMatchObject({ tasks: 2, runs: 4, pass1: 0.75, passAll: 0.5, falseDone: 0.25, refused: 0, infraErrors: 1, cacheHitRatio: 0.9 });
    expect(s.costPerPass).toBeCloseTo(0.04 / 3);
  });

  test("estimates cost from measured tokens at the target model's price", () => {
    const measured = [{ reported: { tokens: { input: 1_000_000, cacheRead: 0, output: 0 } } }] as Result[];
    expect(estimateCost("anthropic/claude-haiku-5-5", 2, measured).usd).toBeGreaterThan(0);
    expect(estimateCost("anthropic/claude-haiku-5-5", 1).basis).toContain("default");
  });

  test("runs a task end to end against cedia with the faux model, offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cedia-evalrun-"));
    const script = join(dir, "script.json");
    const call = (id: string, command: string) => ({ blocks: [{ type: "tool_use", id, name: "bash", input: { command } }] });
    writeFileSync(script, JSON.stringify([call("c1", "echo good > f.txt"), call("c2", "grep -q good f.txt"), { blocks: [{ type: "text", text: "fixed" }] }]));
    Object.assign(process.env, { CEDIA_FAUX_SCRIPT: script, CEDIA_HOME: join(dir, "home"), CEDIA_SANDBOX: "off" });
    try {
      const task: Task = { id: "t", category: "c", prompt: "make f.txt say good", setup: { "f.txt": "bad\n" }, verify: "grep -q good f.txt" };
      const r = await runTask(task, "cedia", "faux");
      expect(r).toMatchObject({ passed: true, claimedDone: true, falseDone: false, refusedClaim: false, infraError: false, reported: { subtype: "success" } });
      expect(r.ledger.map((l) => l.kind)).toEqual(["rollout", "session"]);
    } finally {
      delete process.env.CEDIA_FAUX_SCRIPT;
      delete process.env.CEDIA_SANDBOX;
      delete process.env.CEDIA_HOME;
    }
  });
});
