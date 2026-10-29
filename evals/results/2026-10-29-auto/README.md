# A light triage tier in auto (2026-10-29)

Question: in `-m auto`, can the triage cheaply plan the changes that are plain once the code is read (LIGHT, an Opus plan at low effort) and save more than the Sonnet review alone?

- One arm, run on the 19 tasks of `../2026-10-29-cheaper-opus/` and compared with that run's base and sonnet-review arms, which were not run again:
  ```
  bun evals/run.ts --harness cedia --model opencode-go/claude-haiku-5-5 --runs 1 --jobs 2 \
    --review claude-code:sonnet@high --cedia-arg=--plan=claude-code:opus@medium --cedia-arg=--plan-light=low
  ```
- The arm ran the code of b034645, which was reverted in the next commit. With `--plan-light` set, that code gave the triage (Haiku) a three-way prompt: DIRECT, LIGHT or PLAN.
- No blind panel was run. The result below settled the question without one, and the panel would have cost about $2.

| | base | sonnet-review | auto with a light tier |
|---|---|---|---|
| pass@1 | 19/19 | 19/19 | 18/19 |
| no plan (DIRECT) | 4 | 4 | **1** |
| light plans | | | 2 |
| plans at medium | 15 | 15 | **16** |
| plan cost | $1.87 | $2.01 | $1.93 |
| review cost | $2.80 | $1.22 | $1.33 |
| cost per task, at API price | $0.252 | $0.177 | $0.177 |
| wall time, sum of 19 | 1996 s | 1963 s | 1785 s |

What it says:
- The tier did not shift work to cheaper plans. It moved work from no plan to a plan.
  - The two-way triage sent bugfix-simple, feature-simple, refactor-rename and tb-dedup straight to the writer in every earlier run.
  - With three choices, Haiku planned bugfix-simple at medium and refactor-rename and tb-dedup at low.
  - Every task the two-way triage planned, it planned at medium.
  - Net effect: 18 plans instead of 15, and the same cost per task as the Sonnet review alone.
- hard-redact-bugs failed. The writer followed the review's finding, broke a visible test, and the done gate refused the claim. The same task passed in all three arms of `../2026-10-29-cheaper-opus/`. On one run per task, this is within the noise.

Decision: `-m auto` keeps the two-way triage and reviews with Sonnet at high, the measured sonnet-review arm. The light tier was taken out.

## The same auto on two real-repo tasks

Question: does a Sonnet review hold up on large diffs? The 19 tasks above are small, and an Opus review asked for changes on 84% of diffs over 100 lines in earlier runs.

- Run with `--review claude-code:sonnet@high --cedia-arg=--plan=claude-code:opus@medium --cedia-arg=--spawn=worktree` on real-slop-guard and real-three-changes. This is the auto of the commit after b034645, run with the worktree split that `../2026-10-24-p21-cedia.jsonl` used.
- Compared with p21's runs of the same two tasks, which were not run again. p21 is an older cedia: Haiku writer, with Opus at medium in Claude Code planning and reviewing.
- Judge: `judge/judge.py`, with each pair judged in both orders. Side `cedia` in `judge/verdicts-auto.json` is this run and side `claude` is p21.

| | real-slop-guard | real-three-changes |
|---|---|---|
| pass | yes (p21 yes) | yes (p21 yes) |
| wall time | 301 s (p21 555 s) | 400 s (p21 515 s) |
| Haiku / plan / review cost | $0.03 / $0.64 / $0.16 | $0.03 / $1.11 / $0.23 |
| the Sonnet review | asked for changes | asked for changes |
| blind | tie (the two orders split) | **this run wins** (both orders) |
| Claude Code alone on Opus, the same task | $0.84, 159 s | $1.22, 170 s |

What it says:
- On these two diffs (about 28 KB each), the Sonnet review still sent the writer back, and review was the cheap step: $0.16-0.23. On real tasks the Opus plan is most of the cost.
- The judge marked p21 down on scope, because it edited test files the task said to leave alone. The scope rules were added to cedia after p21, so part of this win is the newer prompts, not the review.
- On real-slop-guard, in the order p21 won, the judge found this run less robust: a failed diff could crash it, and a renamed test was flagged as deleted. Neither the review nor the hidden tests caught that. Two tasks are too few to say whether an Opus review would have.
