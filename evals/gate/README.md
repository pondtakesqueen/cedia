# Regression gate

```
bun evals/gate.ts --estimate          # what a run will cost, from the baseline's own spend
bun evals/gate.ts                     # run the suite on every model in suite.json and compare
bun evals/gate.ts -m anthropic/claude-haiku-5-5   # one model
bun evals/gate.ts --update-baseline   # run, compare, then store the new numbers as the baseline
bun evals/gate.ts --compare evals/results/<file>.jsonl [--against <rows.jsonl|baseline.json>]   # re-score, free
```

Exit 0: no model got worse. 1: a model regressed. 3: no comparison could be made (no baseline, fewer than 80% of runs scored, the budget stopped the run, or the estimate is above `maxUsd`).

## What it runs

`suite.json`: 24 tasks, 2 runs each, 4 at a time, on Haiku 5.5 (Claude API) and DeepSeek V4.1 Flash (OpenCode Go). The 12 pi-era floor tasks, the 7 hard tasks, the 4 wide and long tasks, and `real-slop-guard`, the cheapest real-repository task. `real-threads` and `real-subthreads` are left out: they cost $0.3 to $0.5 a run on Haiku and hit the 1200 s limit when handoff is on, so they belong in a measured experiment, not a gate. The tasks need `python3 -m pytest` and the full git history (`fetch-depth: 0`).

Each run writes its rows to `evals/results/<date>-gate-<model>-<commit>-<time>.jsonl`. A baseline is `baseline/<model>.json`: the commit, date, runs, jobs and cedia flags it was made with, a hash of each task, and the rows.

## How it decides

Over the tasks both runs have, with provider-error runs left out:

| Check | Fails the gate when |
|---|---|
| pass@1 | lower, and a one-sided Fisher exact test gives p < `passP` (0.1). Lower but not significant is shown as `~` |
| tasks broken | a task passed every baseline run and fails every candidate run (at least 2) |
| false-done | its rate is higher at all: it is the trust guarantee failing |
| cost per task set | the sum of each task's mean cost rises by more than `costRise` (25%) and $0.002 |
| time per task set | the same for wall time, `timeRise` (30%) and 10 s; skipped when `--jobs` differs from the baseline's |
| turns per task set | never: shown to explain a cost or time change |

Cost and time are paired by task, so a run that lost a task to provider errors does not look cheaper. A task whose content changed since the baseline is left out until the baseline is updated. A run with other cedia flags than the baseline's (`--cedia-arg`) is still compared, with a note: that is how an A/B of a flag is read.

The limits were set on existing result files with `--compare`, before any paid run. Pairs that run the same behaviour pass, pairs with a real change fail:

| Candidate against baseline (Haiku 5.5) | Verdict | Why |
|---|---|---|
| hard rerun / hard first round | pass | +3.5% cost, +5.4% time |
| hard spawn on / spawn off (no spawn happened) | pass | -6.9% cost |
| wide spawn on / spawn off | pass | -14% cost and time |
| real spawn on / spawn off | pass | -26% cost: the noise of 2 runs on large tasks |
| hard handoff at 20k / spawn off | regressed | +28% cost, +49% time |
| hard with Sonnet review / rerun | regressed | +580% cost, +61% time |

At 2 runs on 24 tasks the pass check needs 5 failures more than the baseline's (47/48 down to 42/48, p = 0.056; 43/48 gives p = 0.102), so most regressions are caught by the tasks-broken check instead: one task that breaks outright is enough. A smaller spread-out drop shows as `~`; rerun with `--runs 3` or more to settle it.

## Baselines

Stored at e967722 (2026-10-21):

| Model | pass@1 | pass^2 | False-done | Cost per run of the suite | Avg time per run | Failures |
|---|---|---|---|---|---|---|
| Haiku 5.5 | 97.9% (47/48) | 95.8% | 0% | $0.27 | 33 s | `hard-redact-bugs#2` (claim refused) |
| DeepSeek V4.1 Flash | 97.9% (47/48) | 95.8% | 0% | $0.38 | 68 s | `wide-three-features#1` |

A whole gate run costs about $0.65 and takes about 35 minutes, most of it Flash.

## When to update the baseline

- A change meant to move the numbers (a new default, a cheaper path): run `--update-baseline` in the same PR and say in it why the new numbers are right.
- A change to a gate task: its old numbers stop counting until the baseline is updated.
- Never to make a red gate green: read the failing runs' rows first.
