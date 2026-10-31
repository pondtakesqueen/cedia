import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselinePath, baselineRefusal, compare, DEFAULT_SUITE, expectedCost, fisherLower, listCost, loadSuite, taskHash, type Baseline, type Thresholds } from "../evals/gate.ts";
import { HARNESSES, type Result, type Task } from "../evals/run.ts";

const th: Thresholds = { passP: 0.1, costRise: 0.15, timeRise: 0.2, totalRise: 0.4 };

const row = (id: string, run: number, o: { passed?: boolean; falseDone?: boolean; cost?: number; ms?: number; infra?: boolean } = {}): Result => ({
  id, category: "c", harness: "cedia", model: "m", run, ts: "", ledger: [], wallMs: o.ms ?? 60_000, output: "", stderr: "", exitCode: 0,
  reported: { costUsd: o.cost ?? 0.01, turns: 5 }, claimedDone: true, refusedClaim: false, infraError: o.infra ?? false, attempts: 1,
  passed: o.passed ?? true, falseDone: o.falseDone ?? false,
});
// 12 tasks x 2 runs, every run passing unless `f` says otherwise.
const set = (f: (id: string, run: number) => Parameters<typeof row>[2] = () => ({})) =>
  Array.from({ length: 12 }, (_, t) => [1, 2].map((run) => row(`t${t}`, run, f(`t${t}`, run)))).flat();
const status = (c: ReturnType<typeof compare>, name: string) => c.checks.find((x) => x.name === name)?.status;

describe("regression gate", () => {
  test("Fisher's one-sided test matches hand-worked values", () => {
    // 3 failures, all in the candidate: C(24,3)/C(48,3).
    expect(fisherLower(21, 24, 24, 24)).toBeCloseTo(2024 / 17296, 6);
    expect(fisherLower(19, 24, 24, 24)).toBeCloseTo(42504 / 1712304, 6);
    expect(fisherLower(24, 24, 24, 24)).toBeCloseTo(1, 9);
  });

  test("the same numbers pass", () => {
    const c = compare(set(), set(), { thresholds: th });
    expect(c.verdict).toBe("pass");
    expect(c.checks.every((x) => x.status === "ok")).toBe(true);
  });

  test("one failure more is noise, many more is a regression", () => {
    const one = compare(set(), set((id, run) => ({ passed: !(id === "t0" && run === 1) })), { thresholds: th });
    expect(one.verdict).toBe("pass");
    expect(status(one, "pass@1")).toBe("worse");
    const five = compare(set(), set((id, run) => ({ passed: !(run === 1 && ["t0", "t1", "t2", "t3", "t4"].includes(id)) })), { thresholds: th });
    expect(status(five, "pass@1")).toBe("regressed");
    expect(five.verdict).toBe("regressed");
  });

  test("a task that always passed and now always fails fails the gate on its own", () => {
    const c = compare(set(), set((id) => ({ passed: id !== "t3" })), { thresholds: th });
    expect(status(c, "pass@1")).toBe("worse");
    expect(status(c, "tasks broken")).toBe("regressed");
    expect(c.checks.find((x) => x.name === "tasks broken")!.candidate).toContain("t3 (0/2, was 2/2)");
  });

  test("any rise in false-done fails the gate, except on tasks with hidden tests", () => {
    const fd = set((id, run) => (id === "t5" && run === 2 ? { passed: false, falseDone: true } : {}));
    expect(status(compare(set(), fd, { thresholds: th }), "false-done")).toBe("regressed");
    // The run's own checks passed and a spec it could not see failed: a failed run, not an unbacked claim.
    const hidden = compare(set(), fd, { thresholds: th, hiddenTasks: ["t5"] });
    expect(status(hidden, "false-done")).toBe("ok");
    expect(hidden.checks.find((x) => x.name === "false-done")!.note).toContain("0 -> 1 on tasks with hidden tests");
  });

  test("a model priced by the hour is compared at its standard price, from tokens", () => {
    const flash = "opencode-go/deepseek-v4.1-flash";
    const tokens = { input: 100_000, cacheRead: 90_000, output: 2_000 };
    // The same tokens, billed off-peak in the baseline and at peak in the candidate.
    const at = (cost: number) => set(() => ({ cost })).map((r) => ({ ...r, model: flash, reported: { ...r.reported, tokens } }));
    const c = compare(at(0.003), at(0.006), { thresholds: th, model: flash });
    expect(status(c, "cost")).toBe("ok");
    expect(c.checks.find((x) => x.name === "cost")!.note).toContain("at the standard price");
    expect(listCost(flash)!(at(0)[0]!)).toBeCloseTo((10_000 * 0.3 + 90_000 * 0.006 + 2_000 * 1.2) / 1e6, 9);
    expect(listCost("anthropic/claude-haiku-5-5")).toBeUndefined();
    expect(status(compare(set(), set(() => ({ cost: 0.012 })), { thresholds: th, model: "anthropic/claude-haiku-5-5" }), "cost")).toBe("regressed");
  });

  test("cost and time fail past their limit for the typical task or the whole set, paired by task", () => {
    expect(status(compare(set(), set(() => ({ cost: 0.011 })), { thresholds: th }), "cost")).toBe("ok");
    expect(status(compare(set(), set(() => ({ cost: 0.012 })), { thresholds: th }), "cost")).toBe("regressed");
    expect(status(compare(set(), set(() => ({ cost: 0.005 })), { thresholds: th }), "cost")).toBe("better");
    // One expensive task 50% dearer moves the typical task 3.4%, and the whole set past its limit.
    const dear = (k: number) => set((id) => ({ cost: id === "t0" ? k : 0.01 }));
    const spike = compare(dear(1), dear(1.5), { thresholds: th });
    expect(status(spike, "cost")).toBe("regressed");
    expect(spike.checks.find((x) => x.name === "cost")!.note).toContain("typical task +3.4%");
    // One cheap task twice as dear is noise for the set: the typical task moves 6%.
    expect(status(compare(set(), set((id) => ({ cost: id === "t1" ? 0.02 : 0.01 })), { thresholds: th }), "cost")).toBe("ok");
    expect(status(compare(set(), set(() => ({ ms: 80_000 })), { thresholds: th }), "time")).toBe("regressed");
    // Wall time from another concurrency is not compared.
    expect(status(compare(set(), set(() => ({ ms: 80_000 })), { thresholds: th, sameJobs: false }), "time")).toBe("skipped");
    // Jitter on tasks of a few seconds is not a regression however large the ratio.
    expect(status(compare(set(() => ({ ms: 100 })), set(() => ({ ms: 300 })), { thresholds: th }), "time")).toBe("ok");
    // A free model has no cost to compare.
    expect(status(compare(set(() => ({ cost: 0 })), set(() => ({ cost: 0 })), { thresholds: th }), "cost")).toBe("skipped");
  });

  test("provider errors and changed tasks are left out, and too few runs is inconclusive", () => {
    // A provider outage on t0 is not a failure.
    const outage = compare(set(), set((id) => (id === "t0" ? { passed: false, infra: true } : {})), { thresholds: th });
    expect(outage.verdict).toBe("pass");
    // A task that changed since the baseline is not compared, even when it fails now.
    const stale = compare(set(), set((id) => ({ passed: id !== "t3" })), { thresholds: th, staleTasks: ["t3"] });
    expect(stale.verdict).toBe("pass");
    expect(stale.checks[0]).toMatchObject({ name: "tasks", status: "skipped" });
    const lost = compare(set(), set((id) => ({ infra: ["t0", "t1", "t2"].includes(id) })), { thresholds: th });
    expect(lost.verdict).toBe("inconclusive");
  });

  test("the gate suite names existing tasks once, with thresholds and a spend cap", () => {
    const { suite, tasks } = loadSuite(DEFAULT_SUITE);
    expect(new Set(suite.tasks).size).toBe(suite.tasks.length);
    expect(tasks.map((t) => t.id)).toEqual(suite.tasks);
    expect(suite.runs).toBeGreaterThanOrEqual(2);
    expect(suite.maxUsd).toBeGreaterThan(0);
    expect(suite.thresholds).toMatchObject({ passP: expect.any(Number), costRise: expect.any(Number), timeRise: expect.any(Number), totalRise: expect.any(Number) });
  });

  test("the frontier suite names existing tasks and keeps its baselines apart from the gate's", () => {
    const path = join(import.meta.dir, "..", "evals", "gate", "frontier.json");
    const { suite, tasks } = loadSuite(path);
    expect(tasks.map((t) => t.id)).toEqual(suite.tasks);
    expect(suite.runs).toBeGreaterThanOrEqual(4);
    expect(suite.baselineDir).toBe("frontier-baseline");
    // The gate never runs these: they are meant to fail some runs, which would make the gate noisy.
    expect(loadSuite(DEFAULT_SUITE).suite.tasks.filter((t) => t.startsWith("frontier-"))).toEqual([]);
  });

  test("expected cost comes from the baseline's spend, then earlier results, then the token estimate", () => {
    const tasks = ["t0", "t1", "t2"].map((id): Task => ({ id, category: "c", prompt: "p", verify: "true" }));
    const baseline = { results: [row("t0", 1, { cost: 0.1 }), row("t0", 2, { cost: 0.3 })] } as Baseline;
    const history = [row("t0", 1, { cost: 9 }), row("t1", 1, { cost: 0.05 }), row("t1", 2, { cost: 0.5, infra: true })];
    const e = expectedCost("anthropic/claude-haiku-5-5", tasks, 2, baseline, history);
    const guess = expectedCost("anthropic/claude-haiku-5-5", tasks.slice(2), 2).usd;
    expect(e.usd).toBeCloseTo(2 * 0.2 + 2 * 0.05 + guess, 9);
    expect(e.basis).toBe("the baseline for 1, earlier results for 1, a token estimate for 1 of 3 tasks");
  });

  test("a task's hash changes with what decides its result", () => {
    const t: Task = { id: "a", category: "c", prompt: "p", setup: { "f.txt": "x" }, verify: "true" };
    expect(taskHash(t)).toBe(taskHash({ ...t, category: "other" }));
    expect(taskHash(t)).not.toBe(taskHash({ ...t, prompt: "q" }));
    expect(taskHash(t)).not.toBe(taskHash({ ...t, setup: { "f.txt": "y" } }));
  });

  test("a task's hash ignores path order and path spelling", () => {
    const t: Task = {
      id: "a",
      category: "c",
      prompt: "p",
      verify: "true",
      setup: { "README.md": "r", "stats.ts": "s", "stats.test.ts": "t" },
      hidden: { "h/a.ts": "1", "h/b.ts": "2" },
      executable: ["stats.ts", "h/a.ts"],
    };
    const reordered: Task = {
      ...t,
      setup: { "stats.test.ts": "t", "README.md": "r", "stats.ts": "s" },
      hidden: { "h/b.ts": "2", "h/a.ts": "1" },
      executable: ["h/a.ts", "stats.ts"],
    };
    expect(taskHash(t)).toBe(taskHash(reordered));
    expect(taskHash(t)).toBe(taskHash({ ...t, setup: { "README.md": "r", "stats.ts": "s", "./stats.test.ts": "t" } }));
    expect(taskHash({ ...t, setup: { "dir/file.ts": "x" } })).toBe(taskHash({ ...t, setup: { "dir\\file.ts": "x" } }));
    expect(taskHash(t)).not.toBe(taskHash({ ...t, setup: { ...t.setup!, "stats.ts": "changed" } }));
  });

  test("stores a baseline, passes against it, and fails a broken harness, offline with the faux model", () => {
    const dir = mkdtempSync(join(tmpdir(), "cedia-gate-"));
    mkdirSync(join(dir, "tasks"));
    writeFileSync(join(dir, "tasks", "t.json"), JSON.stringify({ id: "t", category: "c", prompt: "make f.txt say good", setup: { "f.txt": "bad\n" }, verify: "grep -q good f.txt" }));
    const suitePath = join(dir, "suite.json");
    writeFileSync(suitePath, JSON.stringify({ name: "mini", tasks: ["t"], runs: 2, jobs: 2, models: ["faux"], maxUsd: 1, thresholds: th, tasksDir: "tasks" }));
    const script = join(dir, "script.json");
    const call = (id: string, command: string) => ({ blocks: [{ type: "tool_use", id, name: "bash", input: { command } }] });
    const say = (word: string) => writeFileSync(script, JSON.stringify([call("c1", `echo ${word} > f.txt`), call("c2", "grep -q good f.txt"), { blocks: [{ type: "text", text: "fixed" }] }]));
    const gate = (...extra: string[]) => {
      const p = Bun.spawnSync(["bun", "evals/gate.ts", "--suite", suitePath, "--baseline-dir", join(dir, "base"), "--results-dir", join(dir, "results"), ...extra], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, CEDIA_FAUX_SCRIPT: script, CEDIA_HOME: join(dir, "home"), CEDIA_SANDBOX: "off" },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
    };

    say("good");
    const first = gate();
    expect(first.code).toBe(3);
    expect(first.out).toContain("faux: NO BASELINE");

    // --allow-dirty: the test runs on whatever tree it is in.
    const stored = gate("--update-baseline", "--allow-dirty");
    expect(stored.code).toBe(0);
    const base = JSON.parse(readFileSync(baselinePath("faux", join(dir, "base")), "utf8")) as Baseline;
    expect(base).toMatchObject({ suite: "mini", model: "faux", runs: 2, jobs: 2 });
    expect(base.results.map((r) => r.passed)).toEqual([true, true]);
    expect(Object.keys(base.taskHashes)).toEqual(["t"]);

    const again = gate();
    expect(again.out).toContain("faux: PASS");
    expect(again.code).toBe(0);

    say("bad");
    const broken = gate();
    expect(broken.out).toContain("faux: REGRESSED");
    expect(broken.out).toContain("t (0/2, was 2/2)");
    expect(broken.code).toBe(1);

    // Each run's rows are kept, and --compare scores them again without running anything.
    const files = readdirSync(join(dir, "results")).sort();
    expect(files.length).toBeGreaterThanOrEqual(1);
    const rescored = gate("--compare", join(dir, "results", files.at(-1)!));
    expect(rescored.code).toBe(1);
    expect(rescored.out).toContain("faux: REGRESSED");

    // A run that regressed does not replace the baseline it failed against, unless the change says it should.
    const before = readFileSync(baselinePath("faux", join(dir, "base")), "utf8");
    const refused = gate("--update-baseline", "--allow-dirty");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("not stored as the baseline: the run regressed");
    expect(readFileSync(baselinePath("faux", join(dir, "base")), "utf8")).toBe(before);
    const accepted = gate("--update-baseline", "--allow-dirty", "--accept-regression");
    expect(accepted.code).toBe(0);
    expect((JSON.parse(readFileSync(baselinePath("faux", join(dir, "base")), "utf8")) as Baseline).results.map((r) => r.passed)).toEqual([false, false]);
  }, 60_000);

  test("a baseline comes only from a committed tree and a run that did not regress", () => {
    const ok = { dirty: false, allowDirty: false, verdict: "pass" as const, acceptRegression: false, stopped: false, scored: 50, planned: 50 };
    expect(baselineRefusal(ok)).toBeUndefined();
    expect(baselineRefusal({ ...ok, verdict: "inconclusive" })).toBeUndefined(); // no baseline yet
    expect(baselineRefusal({ ...ok, dirty: true })).toContain("uncommitted changes");
    expect(baselineRefusal({ ...ok, dirty: true, allowDirty: true })).toBeUndefined();
    expect(baselineRefusal({ ...ok, verdict: "regressed" })).toContain("regressed");
    expect(baselineRefusal({ ...ok, verdict: "regressed", acceptRegression: true })).toBeUndefined();
    expect(baselineRefusal({ ...ok, scored: 39 })).toContain("provider errors");
    expect(baselineRefusal({ ...ok, stopped: true })).toContain("stopped early");
  });

  test("refuses to start a run whose estimate is above the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "cedia-gate-cap-"));
    mkdirSync(join(dir, "tasks"));
    writeFileSync(join(dir, "tasks", "t.json"), JSON.stringify({ id: "t", category: "c", prompt: "p", setup: {}, verify: "true" }));
    const suitePath = join(dir, "suite.json");
    writeFileSync(suitePath, JSON.stringify({ name: "cap", tasks: ["t"], runs: 2, jobs: 1, models: ["anthropic/claude-opus-5-5"], maxUsd: 0.0001, thresholds: th, tasksDir: "tasks" }));
    const p = Bun.spawnSync(["bun", "evals/gate.ts", "--suite", suitePath, "--baseline-dir", join(dir, "base")], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(3);
    expect(p.stderr.toString()).toContain("pass --budget");
  });

  test("the cedia harness runs under an isolated home, so user settings never join an eval", () => {
    const dir = mkdtempSync(join(tmpdir(), "cedia-harness-iso-"));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const inv = HARNESSES.cedia!({ id: "t", category: "c", prompt: "say hi" } as Task, repo, "faux");
    // Beside the workspace, never inside it (the model must not see session logs): under the OS temp dir.
    const home = inv.env?.CEDIA_HOME ?? "";
    expect(home.startsWith(join(tmpdir(), ""))).toBe(true);
    expect(home.startsWith(repo)).toBe(false);
    const script = join(dir, "script.json");
    writeFileSync(script, JSON.stringify([{ blocks: [{ type: "text", text: "done" }] }]));
    const p = Bun.spawnSync(["bin/cedia", "-m", "faux", "--cwd", repo, "-p", "say hi", "--sandbox", "off"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CEDIA_FAUX_SCRIPT: script, ...inv.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
    const [slug] = readdirSync(join(home, "sessions"));
    const [file] = readdirSync(join(home, "sessions", slug!));
    const events = readFileSync(join(home, "sessions", slug!, file!), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const names = (events.find((e) => e.kind === "session")?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n: string) => n.startsWith("mcp__"))).toEqual([]);
  });
});
