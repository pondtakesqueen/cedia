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
