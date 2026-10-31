# Plan prompt changes against Claude Code Opus xhigh (2026-10-30)

The question: can a change to the plan step make `-m auto` (plan on Claude Code Opus at medium effort, Haiku 5.5 writing, Claude Code Sonnet reviewing in the sandbox) as good as Claude Code on Opus at effort xhigh? Four arms were tried against the plan prompt on main. None of them made the code better. Main is unchanged.

## How it was measured

Each arm ran from a git worktree of its own, so `bin/cedia` was that arm's code:

```
bun evals/run.ts --harness cedia --model anthropic/claude-haiku-5-5 --review claude-code:sonnet@medium \
  --cedia-arg=--plan=claude-code:opus@medium --cedia-arg=--sandbox=on --runs <3|2> --jobs 2 --only <tasks>
```

- Tuning tasks (10 × 3 runs) were compared with Claude Code Opus at effort xhigh: `cc-xhigh/runs.jsonl`, 30 of 30 passed. These are the same diffs every arm's tuning panel judged. `claude-effort-xhigh.sh` is the `CEDIA_EVAL_CLAUDE_BIN` wrapper, and the runs used `CEDIA_EVAL_RUN_BUDGET=3 --harness claude --model opus`. The subscription's limit cut the first run short (`cc.log`), so the failed tasks were run again (`cc2.log`), and only passed runs are kept. Held-out tasks (8 × 2 runs) were compared with Claude Code Opus high: `2026-10-29-opus-high/held-out/cc.jsonl`.
- `judge.py` in this folder is the prompt those verdicts were asked. It is not re-run. The next panel's prompt is `evals/judge/tpl6-claude-p/judge.py`. It scores correctness, quality, scope, and security, ignores tests, and may answer `unknown`.
- `tally.py <dir> <arm>` is the tally of the judge's `winner` field, tests included. A pair counts when both orders agree.
- `bun evals/score.ts pair` is the tally without tests. It sums correctness, quality, scope, and security. A margin under the threshold is a tie for that order. A pair is a win only when both orders on both panels give the same side a lead of at least the threshold, and `winner` names that side. A disagreement is a tie and is flagged. The headline threshold is 3.

The tally without tests is the one that decides. On the committed main-versus-xhigh verdicts it is cedia 0 / xhigh 1 / tie 29. The one loss is hard-pool run 1. Threshold 2 is 1 / 2 / 27. Threshold 4 is 0 / 0 / 30. The older per-panel figure, any lead above 0 and one panel at a time, was 4-10 and 4-10. That rule is not the one that decides. Claude Code Opus xhigh added tests in 15 of 30 tuning runs, and cedia added them in 30 of 30. On the 15 pairs where Claude Code wrote none, cedia won 29 of 30 judgements. Where both wrote tests, the judgements were close: 17-13 (Sonnet) and 16-14 (Opus). There Claude Code scored higher on correctness (8.53 against 8.27, and 8.97 against 8.53), on quality and on scope.

## Results

Wins and losses for cedia, Sonnet panel / Opus panel. Splits are left out.

| Arm | Tuning, with tests | Tuning, without tests | Held-out, with tests | Held-out, without tests |
|---|---|---|---|---|
| main (plan on Opus medium) | 19-9 / 18-10 | **0 / 1 / 29 combined** | 9-4 / 10-3 | **6-2 / 8-4** |
| narrowed habits (`sc`, `hsc`) | 17-9 / 14-11 | 2-12 / 1-16 | 9-3 / 8-4 | 4-6 / 5-7 |
| narrowed habits + planner probes (`pp`, `hpp`) | 21-5 / 20-5 | 2-12 / 0-13 | 7-6 / 7-6 | 3-9 / 3-8 |
| tests where needed (`nt`, `hnt`) | 13-15 / 10-16 | 3-9 / 2-12 | 6-8 / 4-9 | 7-5 / 3-6 |
| planner probes alone (`po`, `hpo`) | 20-8 / 16-10 | 4-10 / 3-13 | 10-4 / 10-5 | 4-4 / 4-5 |

For main against xhigh on the tuning tasks, the cedia runs are `2026-10-29-opus-high/auto-planmed.jsonl` and the verdicts are `main/judge` and `main/opus` here. The without-tests cell for main is the combined tally at threshold 3 (`bun evals/score.ts pair` on those two files). The other without-tests cells are the older per-panel tally, any lead above 0, and were not re-tallied. Main's held-out row is from `2026-10-29-opus-high/held-out/judge-planmed` and `judge-opus/held-out-planmed`, which compare against Claude Code high. Main's tuning panel in `2026-10-29-opus-high/judge-planmed` compares against Claude Code high, not xhigh, so its tally differs from the one here.

Tuning runs, per passed run:

| Arm | Passed | Time | API spend |
|---|---|---|---|
| main | 30/30 | 158 s | $0.0120 |
| narrowed habits | 30/30 | 184 s | $0.0126 |
| habits + probes | 30/30 | 195 s | $0.0128 |
| tests where needed | 30/30 | 153 s | $0.0093 |
| probes alone | 30/30 | 184 s | $0.0127 |

On the held-out tasks, `frontier-semver#1` timed out at 300 s for both habits arms. Every other run passed.

## The arms

- **Narrowed habits** (`narrowed-habits.patch`). These are five plan rules drawn from where xhigh won on the tuning tasks: input types, copies of caller-owned input, module-level state, exact decimals, and exhaustive short inputs. They were limited to the code the change touches. The broad version had won on tuning (23-4-3 and 20-5-5 with tests), but its scope fell to 7.6–8.0. Narrowing did not bring scope back, and without tests both versions lost more often than main.
- **Planner probes** (`plan-probe.patch`). With the sandbox on, a Claude Code planner may run `bun -e` (Claude Code's own sandbox: no network, no writes to the tree) and is asked to try the code as it stands before it plans. Stacked on the habits, it won on tuning with tests (21-5, 20-5) and lost everywhere without them. Alone, it matched main on tuning, did slightly worse on held-out, and took 26 s more.
- **Tests where needed** (`tests-when-needed.patch`). The planner, the review and the writer's bug-fix rule add a test only where a rule could break with no existing test or check showing it, as xhigh does. cedia still added tests in 29 of 30 tuning runs, only fewer of them. Scope rose to the level of Claude Code (8.8–8.9) and API spend fell 22%, but the tallies did not beat main.

## What this says

The rules were written from the tuning tasks, so the tuning numbers lean their way. On the held-out tasks, every arm did worse without tests than main. The gap to xhigh on the code itself (correctness, quality and scope) is not something these plan prompts close. The next ideas have to come from somewhere else. The goals and how they are measured are in `docs/ROADMAP.md`, under Goals.

Panels: 16 or 30 pairs each, so a difference of two or three wins is within noise. Twice during the day, the subscription's 5-hour limit cut a run or a panel short (`api_error_status 429`). Those runs and judgements were rerun whole, and none are counted here.
