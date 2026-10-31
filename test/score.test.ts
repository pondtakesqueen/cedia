import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combinePanels, loadVerdicts, passAtK, passCaretK, tallyCounts, trialReport, readTrials, type VerdictRow } from "../evals/score.ts";

const SONNET = new URL("../evals/results/2026-10-30-plan-habits/main/judge/verdicts-opmed.json", import.meta.url).pathname;
const OPUS = new URL("../evals/results/2026-10-30-plan-habits/main/opus/verdicts-opmed.json", import.meta.url).pathname;
const XHIGH = new URL("../evals/results/2026-10-30-plan-habits/cc-xhigh/runs.jsonl", import.meta.url).pathname;

const panels = () => ({ sonnet: loadVerdicts(SONNET), opus: loadVerdicts(OPUS) });

describe("pairwise tally", () => {
  test("threshold 3, 2, and 4 match the committed re-tally", () => {
    const loaded = panels();
    const at = (threshold: number) => tallyCounts(combinePanels(loaded, threshold));
    expect(at(3)).toEqual({ cedia: 0, xhigh: 1, tie: 29, flagged: 24 });
    expect(at(2)).toEqual({ cedia: 1, xhigh: 2, tie: 27, flagged: 24 });
    expect(at(4)).toEqual({ cedia: 0, xhigh: 0, tie: 30, flagged: 24 });
  });

  test("the only threshold-3 win is hard-pool run 1 for xhigh", () => {
    const wins = combinePanels(panels(), 3).filter((pair) => pair.result !== "tie");
    expect(wins.map((pair) => `${pair.task}#${pair.run} ${pair.result}`)).toEqual(["hard-pool#1 xhigh"]);
  });

  test("a winner that disagrees with the four-axis side is a tie, and the letter does not pick the side", () => {
    const row = (order: number, a: string, cedia: number, xhigh: number, winner: string): VerdictRow => ({
      task: "t",
      run: 1,
      order,
      a,
      verdict: {
        A: { correctness: a === "cedia" ? cedia : xhigh, quality: 0, scope: 0, security: 0, tests: 9 },
        B: { correctness: a === "cedia" ? xhigh : cedia, quality: 0, scope: 0, security: 0, tests: 1 },
        winner,
      },
    });
    const one = (orders: VerdictRow[]) => {
      const panel = new Map([["t#1", orders]]);
      return combinePanels({ a: panel, b: panel }, 3)[0]!;
    };
    const lead = one([row(1, "cedia", 10, 6, "B"), row(2, "claude", 10, 6, "A")]);
    expect(lead.result).toBe("tie");
    expect(lead.flagged).toBe(true);
    const agree = one([row(1, "cedia", 10, 6, "A"), row(2, "claude", 10, 6, "B")]);
    expect(agree.result).toBe("cedia");
    expect(agree.flagged).toBe(false);
  });
});

describe("trial grade", () => {
  test("pass@k and pass^k follow the binomial estimators", () => {
    expect(passAtK(4, 3, 1)).toBeCloseTo(0.75);
    expect(passCaretK(4, 3, 1)).toBeCloseTo(0.75);
    expect(passAtK(4, 3, 2)).toBeCloseTo(1);
    expect(passCaretK(4, 3, 2)).toBeCloseTo(0.5);
    expect(passCaretK(4, 3, 4)).toBe(0);
    expect(passAtK(4, 3, 4)).toBe(1);
  });

  test("the three hard-csv-stream rows are invalid and the cc2.log slice matches", () => {
    const rows = readTrials(XHIGH);
    const report = trialReport(rows);
    expect(report.invalid.map((row) => `${row.id}#${row.run}`).sort()).toEqual([
      "hard-csv-stream#1",
      "hard-csv-stream#2",
      "hard-csv-stream#3",
    ]);
    expect(report.invalid.every((row) => row.because.join("+") === "limit")).toBe(true);
    expect(report.scored).toHaveLength(27);
    expect(report.meanMs / 1000).toBeCloseTo(140.0, 0);
    expect(report.meanUsd!).toBeCloseTo(0.5125, 3);

    const cc2 = new Set(["hard-injection", "hard-ledger", "hard-memo-async", "hard-pool", "hard-sse", "wide-bug-hunt", "wide-three-features"]);
    const slice = report.scored.filter((row) => cc2.has(row.id));
    expect(slice).toHaveLength(21);
    const meanMs = slice.reduce((sum, row) => sum + row.wallMs, 0) / slice.length;
    const meanUsd = slice.reduce((sum, row) => sum + (row.reported?.costUsd ?? 0), 0) / slice.length;
    expect(meanMs / 1000).toBeCloseTo(141.5, 1);
    expect(meanUsd).toBeCloseTo(0.5224, 4);
    expect(report.pass1).toBe(1);
  });

  test("a limit message is invalid, and a bare nonzero exit stays scored", () => {
    const row = (over: Partial<ReturnType<typeof readTrials>[number]>): ReturnType<typeof readTrials>[number] => ({
      id: "t", run: 1, wallMs: 1000, exitCode: 0, output: "done", passed: true, infraError: false, reported: { costUsd: 0.1 }, ...over,
    });
    const limit = trialReport([row({ exitCode: 1, output: "You've hit your 5-hour limit · resets 5am (UTC)", passed: true })]);
    expect(limit.invalid.map((item) => item.because)).toEqual([["limit"]]);
    expect(limit.scored).toHaveLength(0);

    const miss = trialReport([row({ exitCode: 1, output: "bun test failed: 2 fail", passed: false })]);
    expect(miss.invalid).toHaveLength(0);
    expect(miss.scored.map((item) => item.passed)).toEqual([false]);
    expect(miss.pass1).toBe(0);

    const ok = trialReport([row({ exitCode: 0, output: "done", passed: true })]);
    expect(ok.invalid).toHaveLength(0);
    expect(ok.pass1).toBe(1);
    expect(ok.scored).toHaveLength(1);

    const kept = trialReport([row({ exitCode: 1, output: "done", passed: true })]);
    expect(kept.invalid).toHaveLength(0);
    expect(kept.pass1).toBe(1);
    expect(kept.scored).toHaveLength(1);
  });
});

const POOL_DIFF = new URL("../evals/results/2026-10-29-opus-high/judge-planmed/opmed-hard-pool-1.diff", import.meta.url).pathname;

describe("hard-pool contract", () => {
  test("the committed cedia diff fails the Symbol limit case", () => {
    const dir = mkdtempSync(join(tmpdir(), "cedia-pool-diff-"));
    const stub = new URL("../evals/tasks/hard-pool/files/pool.ts", import.meta.url).pathname;
    const hidden = new URL("../evals/tasks/hard-pool/hidden/pool.hidden.test.ts", import.meta.url).pathname;
    cpSync(stub, join(dir, "pool.ts"));
    cpSync(hidden, join(dir, "pool.hidden.test.ts"));
    const diff = readFileSync(POOL_DIFF, "utf8");
    const marker = "diff -ruN '--exclude=node_modules' '--exclude=.git' a/pool.ts b/pool.ts\n";
    const start = diff.indexOf(marker);
    const next = diff.indexOf("\ndiff -ruN ", start + marker.length);
    const hunk = diff.slice(start, next === -1 ? undefined : next + 1);
    const patch = join(dir, "pool.patch");
    writeFileSync(patch, hunk);
    const applied = Bun.spawnSync(["patch", "-p1", "--forward", "--input", patch], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    const ran = Bun.spawnSync(["bun", "test", "pool.hidden.test.ts", "-t", "Symbol limit"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const output = ran.stdout.toString() + ran.stderr.toString();
    expect(ran.exitCode).not.toBe(0);
    expect(output).toContain("TypeError");
  });
});
