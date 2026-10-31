#!/usr/bin/env bun
import { readFileSync } from "node:fs";

export const AXES = ["correctness", "quality", "scope", "security"] as const;

export type Side = "cedia" | "xhigh";
type FileSide = "cedia" | "claude";
export type AxisSide = FileSide | "tie";
export type WinnerSide = AxisSide | "unknown";

type ScoreBlock = Record<string, unknown>;

export type VerdictRow = {
  task: string;
  run: number;
  order: number;
  a: string;
  verdict: { A: ScoreBlock; B: ScoreBlock; winner: string };
};

export type OrderView = {
  order: number;
  cedia: number;
  claude: number;
  margin: number;
  axis: AxisSide;
  winner: string;
  winnerSide: WinnerSide;
};

export type PanelPair = {
  task: string;
  run: number;
  result: Side | "tie";
  flagged: boolean;
  reasons: string[];
};

export type CombinedPair = PanelPair & { panels: Record<string, PanelPair> };

export type TallyCounts = { cedia: number; xhigh: number; tie: number; flagged: number };

const DISPLAY: Record<FileSide, Side> = { cedia: "cedia", claude: "xhigh" };
const OTHER: Record<FileSide, FileSide> = { cedia: "claude", claude: "cedia" };

function sumAxes(block: ScoreBlock, where: string): number {
  let total = 0;
  for (const [key, value] of Object.entries(block)) {
    if (key === "tests") continue;
    if (typeof value !== "number") throw new Error(`non-numeric axis ${key}=${String(value)} in ${where}`);
    total += value;
  }
  return total;
}

export function axisSums(row: VerdictRow): { cedia: number; claude: number } {
  if (row.a !== "cedia" && row.a !== "claude") throw new Error(`bad a=${JSON.stringify(row.a)} in ${row.task}#${row.run}`);
  const hidden = row.a === "cedia" ? "claude" : "cedia";
  const raw: Record<string, number> = {
    [row.a]: sumAxes(row.verdict.A, `${row.task}#${row.run}`),
    [hidden]: sumAxes(row.verdict.B, `${row.task}#${row.run}`),
  };
  return { cedia: raw.cedia!, claude: raw.claude! };
}

export function axisSide(sums: { cedia: number; claude: number }): AxisSide {
  if (sums.cedia > sums.claude) return "cedia";
  if (sums.claude > sums.cedia) return "claude";
  return "tie";
}

export function winnerSide(row: VerdictRow): WinnerSide {
  const shown: FileSide = row.a === "cedia" ? "cedia" : "claude";
  const winner = row.verdict.winner;
  if (winner === "tie") return "tie";
  if (winner === "unknown") return "unknown";
  if (winner === "A") return shown;
  if (winner === "B") return OTHER[shown];
  throw new Error(`bad winner ${JSON.stringify(winner)} in ${row.task}#${row.run}`);
}

export function orderView(row: VerdictRow): OrderView {
  const sums = axisSums(row);
  const lead = sums.cedia - sums.claude;
  return {
    order: row.order,
    cedia: sums.cedia,
    claude: sums.claude,
    margin: Math.abs(lead),
    axis: axisSide(sums),
    winner: row.verdict.winner,
    winnerSide: winnerSide(row),
  };
}

function groupPairs(rows: VerdictRow[]): Map<string, VerdictRow[]> {
  const pairs = new Map<string, VerdictRow[]>();
  for (const row of rows) {
    const key = `${row.task}\0${row.run}`;
    const list = pairs.get(key) ?? [];
    list.push(row);
    pairs.set(key, list);
  }
  for (const [key, orders] of pairs) {
    if (orders.length !== 2) throw new Error(`${key} has ${orders.length} orders`);
    orders.sort((a, b) => a.order - b.order);
  }
  return pairs;
}

export function panelPair(orders: VerdictRow[], threshold: number): PanelPair {
  const views = orders.map(orderView);
  const reasons: string[] = [];
  let flagged = false;
  for (const view of views) {
    if (view.winnerSide !== view.axis) {
      flagged = true;
      reasons.push(`order ${view.order}: winner ${view.winnerSide} vs 4-axis ${view.axis} (margin ${view.margin})`);
    }
  }
  const decided = views.map((view) => (view.margin >= threshold && view.axis !== "tie" ? view.axis : "tie"));
  const left = decided[0] ?? "tie";
  const right = decided[1] ?? "tie";
  let fileResult: FileSide | "tie" = left === right && left !== "tie" ? left : "tie";
  if (flagged) fileResult = "tie";
  const result: Side | "tie" = fileResult === "tie" ? "tie" : DISPLAY[fileResult];
  return { task: orders[0]!.task, run: orders[0]!.run, result, flagged, reasons };
}

export function countOutcomes(results: Iterable<Side | "tie">): { cedia: number; xhigh: number; tie: number } {
  const counts = { cedia: 0, xhigh: 0, tie: 0 };
  for (const result of results) counts[result]++;
  return counts;
}

export function combinePanels(panels: Record<string, Map<string, VerdictRow[]>>, threshold: number): CombinedPair[] {
  const names = Object.keys(panels);
  const keys = [...panels[names[0]!]!.keys()].sort();
  for (const name of names) {
    const have = panels[name]!;
    if (have.size !== keys.length) throw new Error(`${name} has ${have.size} pairs, expected ${keys.length}`);
    for (const key of keys) if (!have.has(key)) throw new Error(`${name} missing ${key}`);
  }
  return keys.map((key) => {
    const byPanel: Record<string, PanelPair> = {};
    for (const name of names) byPanel[name] = panelPair(panels[name]!.get(key)!, threshold);
    const first = byPanel[names[0]!]!;
    const agreed = names.every((name) => byPanel[name]!.result === first.result) && first.result !== "tie";
    return {
      task: first.task,
      run: first.run,
      result: agreed ? first.result : "tie",
      flagged: names.some((name) => byPanel[name]!.flagged),
      reasons: names.flatMap((name) => byPanel[name]!.reasons.map((reason) => `${name}: ${reason}`)),
      panels: byPanel,
    };
  });
}

export function tallyCounts(pairs: CombinedPair[]): TallyCounts {
  const counts = countOutcomes(pairs.map((pair) => pair.result));
  return { ...counts, flagged: pairs.filter((pair) => pair.flagged).length };
}

export function loadVerdicts(path: string): Map<string, VerdictRow[]> {
  return groupPairs(JSON.parse(readFileSync(path, "utf8")) as VerdictRow[]);
}

export function formatTally(threshold: number, counts: TallyCounts, wins: CombinedPair[]): string {
  const lines = [`threshold ${threshold} combined cedia ${counts.cedia} / xhigh ${counts.xhigh} / tie ${counts.tie} / flagged ${counts.flagged}`];
  for (const pair of wins.filter((pair) => pair.result !== "tie")) lines.push(`  ${pair.task}#${pair.run} ${pair.result}`);
  return lines.join("\n");
}

const LIMIT_MESSAGE = /you'?ve hit your \S+ limit|5-hour limit|limit reached|out of credits|insufficient (?:balance|credits?|funds)|\bquota\b/i;
const LIMIT_MESSAGE_MAX_CHARS = 400;

export function isLimitMessage(output: string): boolean {
  const text = output.trim();
  return text.length > 0 && text.length <= LIMIT_MESSAGE_MAX_CHARS && LIMIT_MESSAGE.test(text) && !/\bno usage limit\b/i.test(text);
}

export type TrialFields = {
  id: string;
  run: number;
  wallMs: number;
  exitCode: number;
  output: string;
  passed: boolean;
  infraError?: boolean;
  reported?: { costUsd?: number };
};

export type InvalidBecause = "limit";

/** A scored trial. Provider errors and a short limit or quota message are left out. A nonzero exit is not, by itself, evidence of either. */
export function countsTowardRate(row: { exitCode: number; output: string; infraError?: boolean }): boolean {
  if (row.infraError) return false;
  if (isLimitMessage(row.output ?? "")) return false;
  return true;
}

export function invalidBecause(row: { output: string }): InvalidBecause[] {
  return isLimitMessage(row.output ?? "") ? ["limit"] : [];
}

export function binomial(n: number, k: number): number {
  if (k < 0 || n < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/** Probability at least one of k draws passes, given c passes in n trials. */
export function passAtK(n: number, c: number, k: number): number {
  if (k <= 0 || k > n) return Number.NaN;
  if (n - c < k) return 1;
  return 1 - binomial(n - c, k) / binomial(n, k);
}

/** Probability all k draws pass. */
export function passCaretK(n: number, c: number, k: number): number {
  if (k <= 0 || k > n) return Number.NaN;
  if (c < k) return 0;
  return binomial(c, k) / binomial(n, k);
}

export type TaskCurve = { id: string; n: number; c: number; points: { k: number; passAt: number; passCaret: number }[] };

export function taskCurves(rows: { id: string; passed: boolean }[]): TaskCurve[] {
  const byTask = new Map<string, { n: number; c: number }>();
  for (const row of rows) {
    const cell = byTask.get(row.id) ?? { n: 0, c: 0 };
    cell.n++;
    if (row.passed) cell.c++;
    byTask.set(row.id, cell);
  }
  return [...byTask.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, cell]) => ({
    id,
    n: cell.n,
    c: cell.c,
    points: Array.from({ length: cell.n }, (_, i) => {
      const k = i + 1;
      return { k, passAt: passAtK(cell.n, cell.c, k), passCaret: passCaretK(cell.n, cell.c, k) };
    }),
  }));
}

export function overallCurve(curves: TaskCurve[]): { k: number; tasks: number; passAt: number; passCaret: number }[] {
  const maxK = curves.reduce((max, curve) => Math.max(max, curve.n), 0);
  const points = [];
  for (let k = 1; k <= maxK; k++) {
    const have = curves.filter((curve) => curve.n >= k);
    if (!have.length) continue;
    const at = (pick: (curve: TaskCurve) => number) => have.reduce((sum, curve) => sum + pick(curve), 0) / have.length;
    points.push({
      k,
      tasks: have.length,
      passAt: at((curve) => curve.points[k - 1]!.passAt),
      passCaret: at((curve) => curve.points[k - 1]!.passCaret),
    });
  }
  return points;
}

export type TrialReport = {
  invalid: { id: string; run: number; because: InvalidBecause[] }[];
  scored: TrialFields[];
  meanMs: number;
  meanUsd: number | undefined;
  pass1: number;
  allTrials: number;
  perTask: TaskCurve[];
  overall: { k: number; tasks: number; passAt: number; passCaret: number }[];
};

export function trialReport(rows: TrialFields[]): TrialReport {
  const invalid = rows
    .filter((row) => !row.infraError && invalidBecause(row).length > 0)
    .map((row) => ({ id: row.id, run: row.run, because: invalidBecause(row) }));
  const scored = rows.filter((row) => countsTowardRate(row));
  const byTask = new Map<string, TrialFields[]>();
  for (const row of scored) byTask.set(row.id, [...(byTask.get(row.id) ?? []), row]);
  const costs = scored.map((row) => row.reported?.costUsd).filter((cost): cost is number => typeof cost === "number");
  const passes = scored.filter((row) => row.passed).length;
  const perTask = taskCurves(scored);
  return {
    invalid,
    scored,
    meanMs: scored.length ? scored.reduce((sum, row) => sum + row.wallMs, 0) / scored.length : 0,
    meanUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : undefined,
    pass1: scored.length ? passes / scored.length : 0,
    allTrials: byTask.size ? [...byTask.values()].filter((group) => group.every((row) => row.passed)).length / byTask.size : 0,
    perTask,
    overall: overallCurve(perTask),
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function formatTrialReport(report: TrialReport): string {
  const lines = [
    `invalid ${report.invalid.length}${report.invalid.length ? `  ${report.invalid.map((row) => `${row.id}#${row.run} (${row.because.join("+")})`).join(", ")}` : ""}`,
    `scored ${report.scored.length}  pass@1 ${pct(report.pass1)}  all-trials ${pct(report.allTrials)}  mean ${(report.meanMs / 1000).toFixed(1)}s  ${report.meanUsd === undefined ? "cost not reported" : `$${report.meanUsd.toFixed(4)} per scored run`}`,
  ];
  if (report.overall.length) {
    lines.push(`pass@k ${report.overall.map((point) => `k=${point.k} ${pct(point.passAt)} (${point.tasks} tasks)`).join("  ")}`);
    lines.push(`pass^k ${report.overall.map((point) => `k=${point.k} ${pct(point.passCaret)} (${point.tasks} tasks)`).join("  ")}`);
  }
  for (const task of report.perTask) {
    lines.push(`${task.id}  ${task.c}/${task.n}  pass@k ${task.points.map((point) => `k=${point.k} ${pct(point.passAt)}`).join(" ")}  pass^k ${task.points.map((point) => `k=${point.k} ${pct(point.passCaret)}`).join(" ")}`);
  }
  return lines.join("\n");
}

export function readTrials(path: string): TrialFields[] {
  const text = readFileSync(path, "utf8").trim();
  const lines = () => text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TrialFields);
  try {
    const parsed = JSON.parse(text) as { results?: TrialFields[] };
    return Array.isArray(parsed.results) ? parsed.results : lines();
  } catch {
    return lines();
  }
}

function parseAt(value: string | undefined): number[] {
  if (!value) return [3];
  return value.split(",").map((part) => Number(part));
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "pair") {
    const paths: string[] = [];
    let at = [3, 2, 4];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--at") at = parseAt(rest[++i]);
      else paths.push(arg);
    }
    if (paths.length < 2) throw new Error("pair needs two verdict files");
    const panels: Record<string, Map<string, VerdictRow[]>> = {};
    for (const path of paths) panels[path] = loadVerdicts(path);
    for (const threshold of at) {
      const pairs = combinePanels(panels, threshold);
      const counts = tallyCounts(pairs);
      console.log(formatTally(threshold, counts, pairs));
    }
    return 0;
  }
  if (command === "trials") {
    const path = rest[0];
    if (!path) throw new Error("trials needs a jsonl file");
    const report = trialReport(readTrials(path));
    console.log(formatTrialReport(report));
    const cc2 = new Set(["hard-injection", "hard-ledger", "hard-memo-async", "hard-pool", "hard-sse", "wide-bug-hunt", "wide-three-features"]);
    const slice = report.scored.filter((row) => cc2.has(row.id));
    const present = new Set(report.scored.map((row) => row.id));
    if ([...cc2].every((id) => present.has(id)) && slice.length !== report.scored.length) {
      const meanMs = slice.reduce((sum, row) => sum + row.wallMs, 0) / slice.length;
      const costs = slice.map((row) => row.reported?.costUsd).filter((cost): cost is number => typeof cost === "number");
      const meanUsd = costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
      console.log(`cc2.log tasks ${slice.length}  mean ${(meanMs / 1000).toFixed(1)}s  $${meanUsd.toFixed(4)} per scored run`);
    }
    return 0;
  }
  console.error("usage: bun evals/score.ts pair <a.json> <b.json> [--at 3,2,4]\n       bun evals/score.ts trials <runs.jsonl>");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
