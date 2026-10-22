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

`suite.json`: 25 tasks, 2 runs each, 4 at a time, on Haiku 5.5 (Claude API) and DeepSeek V4.1 Flash (OpenCode Go). The 12 pi-era floor tasks, the 7 hard tasks, the 4 wide and long tasks, `real-slop-guard`, the cheapest real-repository task, and `real-three-delegated`, which hands three real commits to one work sub-thread: on Haiku that sub-thread passes the 90k handoff point in every run, so the gate checks that sub-thread handoff triggers and the work still passes (about $0.06 a run on Haiku, 5 to 6 minutes). `real-threads` and `real-subthreads` are left out: they cost $0.3 to $0.5 a run on Haiku and hit the 1200 s limit when handoff is on, so they belong in a measured experiment, not a gate. The tasks need `python3 -m pytest` and the full git history (`fetch-depth: 0`).

Each run writes its rows to `evals/results/<date>-gate-<model>-<commit>-<time>.jsonl`. A baseline is `baseline/<model>.json`: the commit, date, runs, jobs and cedia flags it was made with, a hash of each task, and the rows.

## How it decides

Over the tasks both runs have, with provider-error runs left out:

| Check | Fails the gate when |
|---|---|
| pass@1 | lower, and a one-sided Fisher exact test gives p < `passP` (0.1). Lower but not significant is shown as `~` |
| tasks broken | a task passed every baseline run and fails every candidate run (at least 2) |
| false-done | its rate is higher at all: it is the trust guarantee failing. Tasks with hidden tests are left out of this check: there the run's own checks passed and a spec it could not see failed, which is a failed run, counted above |
| cost | the typical task's cost (geometric mean of per-task ratios) rises by more than `costRise` (15%), or the whole set's (sum of per-task means) by more than `totalRise` (40%); either way by more than $0.002. A model with an off-peak price (DeepSeek) is compared at its standard price, from each run's tokens: the Flash gate run of 2026-10-22 started at peak hours and read +63% against an off-peak baseline, +3% at one price |
| time | the same for wall time, `timeRise` (20%) and `totalRise`, by more than 10 s; skipped when `--jobs` differs from the baseline's |
| turns | never: shown to explain a cost or time change |

Cost and time are paired by task, so a run that lost a task to provider errors does not look cheaper. Two limits, because one expensive task is noisy: `real-slop-guard` is 40% of the suite's spend and moved 60% between two runs of the same commit, which put the whole set at +21% with no change; the typical task moved -1% on the same pair. A rise on that one task alone has to pass 40% of the whole set to fail the gate. A task whose content changed since the baseline is left out until the baseline is updated. A run with other cedia flags than the baseline's (`--cedia-arg`) is still compared, with a note: that is how an A/B of a flag is read.

The limits were set by experiment, with `--compare` on existing result files and on a second run of the same commit. Pairs that run the same behaviour pass, pairs with a real change fail (cost and time shown as typical task / whole set):

| Candidate against baseline | Verdict | Cost | Time |
|---|---|---|---|
| Gate suite, Haiku 5.5, second run of e967722 (18f1760) | pass | -1% / +21% | -2% / +12% |
| Gate suite, DeepSeek Flash, second run of e967722 (18f1760) | pass | +2% / +17% | -6% / -18% |
| Hard set, Haiku rerun / first round | pass | +3% / +3% | +5% / +5% |
| Hard set, spawn on / spawn off (no spawn happened) | pass | -8% / -7% | -6% / -7% |
| Wide set, spawn on / spawn off | pass | -15% / -14% | -15% / -14% |
| Real set, spawn on / spawn off | pass | -26% / -26% | -19% / -20% |
| Hard set, handoff at 20k / spawn off | regressed | +18% / +28% | +27% / +49% |
| Hard set, Sonnet review / rerun | regressed | +711% / +580% | +80% / +61% |

The 3- to 7-task sets move up to 26% on noise; the 24-task gate suite moves under 3% for the typical task.

The second run also found a task problem, not a cedia one: 3 of 4 Flash runs of `wide-three-features` read the slug comment's cut rule one way and the hidden test the other, one of them as a false done. The comment now says a "-" right after the first max characters counts; the four Haiku and four Flash runs after the change all passed, and that task's baseline rows were replaced with `--only wide-three-features --update-baseline`.

At 2 runs on 24 tasks the pass check needs 5 failures more than the baseline's (47/48 down to 42/48, p = 0.056; 43/48 gives p = 0.102), so most regressions are caught by the tasks-broken check instead: one task that breaks outright is enough. A smaller spread-out drop shows as `~`; rerun with `--runs 3` or more to settle it.

## Baselines

Stored on main at 32774a7 (2026-10-21; the run's files name 43bd436, a merge with the same tree), after PRs #19 to #22:

| Model | pass@1 | pass^2 | False-done | Cost per run of the suite | Avg time per run |
|---|---|---|---|---|---|
| Haiku 5.5 | 100% (48/48) | 100% | 0% | $0.26 | 29 s |
| DeepSeek V4.1 Flash | 100% (48/48) | 100% | 0% | $0.39 | 50 s |

A whole gate run costs about $0.65 and takes about 35 minutes, most of it Flash.

History:

| Commit | Haiku 5.5 | DeepSeek V4.1 Flash | Note |
|---|---|---|---|
| e967722 | 47/48, $0.27, 33 s | 47/48, $0.38, 68 s | first baseline |
| 18f1760 (same code) | 47/48, $0.32, 37 s | 46/48, $0.45, 56 s | second run; found the `wide-three-features` comment and the cost-noise rules |
| 32774a7 (main) | 48/48, $0.26, 29 s | 48/48, $0.39, 50 s | after #21 (spawn reminder, handoff note carries the plan): PASS on both against the earlier baseline, typical task cost -6% and -3%, time -9% and -8% |
| 26ffc46 (spawn on long tasks) | 47/48, $0.23, 30 s | 48/48, $0.63 at peak price ($0.80 against $0.77 at one price), 55 s | first-session handoff, sub-thread budget meter: PASS on both; `real-three-delegated` added to the suite and its rows stored at 82363a0 |
| 6ef1dfd | 48/48, $0.16, 21 s | (not rerun) | Haiku starts at `low` and escalates to `high` when the done gate refuses a claim: PASS, typical task cost -14%, whole set -36%, time -14%. About half the runs escalated, and every reply after an escalation read the whole previous input from cache. On the 24-task suite; main then added `real-three-delegated`, and the re-record on 25 tasks stopped when the API credit ran out, so `baseline/anthropic_claude-haiku-5-5.json` is still main's at `medium`: run `bun evals/gate.ts -m anthropic/claude-haiku-5-5 --update-baseline` once credit is back |

Effort arms on Haiku 5.5 (2026-10-22, one gate run each, against the 32774a7 baseline at `medium`):

| Arm | pass@1 | Typical task cost | Whole set | Note |
|---|---|---|---|---|
| `medium`, escalate to `high` on a refused claim | 48/48 | +2% | -3% | time +9% |
| `low`, no escalation | 48/48 | -18% | -33% | |
| `low`, escalate on a refused claim or a check failing after a change | 46/48 | -21% | -36% | `hard-redact-bugs` refused twice: after the failed-check note ("cedia raised your effort level") Haiku stopped sooner. That trigger was dropped |
| `low`, escalate on a refused claim (the default) | 48/48 | -21% | -35% | rerun with `--update-baseline`: 48/48, -14%, -36% |
| same, with keep-working, real-check and scope lines from the 5.5 prompting guides in `BASE_SYSTEM` | 47/48 | -16% | -32% | no gain on Haiku; DeepSeek ran at peak-hour prices, so its cost could not be read. Not adopted |

## When to update the baseline

- A change meant to move the numbers (a new default, a cheaper path): run `--update-baseline` in the same PR and say in it why the new numbers are right.
- A change to a gate task: its old numbers stop counting until the baseline is updated, which `--only <task> --update-baseline` does for that task alone.
- Never to make a red gate green: read the failing runs' rows first.
