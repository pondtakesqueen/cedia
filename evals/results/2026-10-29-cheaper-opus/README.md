# Cheaper plan and review roles (2026-10-29)

Question: Opus plan and review output is about 97% of a run's bill. Can a Sonnet review or a low-effort Opus plan cut it and keep quality?

- Three arms, run at the same time on one machine: `bun evals/run.ts --harness cedia --model opencode-go/claude-haiku-5-5 --runs 1 --jobs 2 --review <review> --cedia-arg=--plan=<plan>` on the 19 tasks of `../2026-10-28-overlap/` (plan overlap on, the default since #164).
  - **base**: review `claude-code:opus@medium`, plan `claude-code:opus@medium`
  - **sonnet-review**: review `claude-code:sonnet@high`, plan as base
  - **low-plan**: plan `claude-code:opus@low`, review as base
- Plan and review cost is the `costUsd` Claude Code reports for each step (API list price; the runs themselves drew on a subscription). `evals/run.ts` keeps it from this run on.
- Judge: `judge/judge.py` (a copy of `evals/judge/tpl6-claude-p/judge.py`), `claude -p` Sonnet, each pair in both orders; a win counts only when both orders agree. Side `claude` in `judge/verdicts-*.json` and `judge/mapping-*.json` is **base**; side `cedia` is the arm named in the file.

| | base | sonnet-review | low-plan |
|---|---|---|---|
| pass@1 | 19/19 | 19/19 | 19/19 |
| wall time, sum of 19 | 1996 s | 1963 s | 1844 s (-8%) |
| Haiku cost | $0.117 | $0.129 | $0.110 |
| plans (15 each): cost, time | $1.87, 606 s | $2.01, 630 s | **$1.34 (-28%), 397 s (-35%)** |
| reviews (15 each): cost, time | $2.80, 749 s | **$1.22 (-56%), 477 s (-36%)** | $2.98, 789 s |
| review sent the writer back | 11 | 9 | 10 |
| cost per task, all at API price | $0.252 | **$0.177 (-30%)** | $0.233 (-7%) |
| blind wins against base | | 6 to 5 (8 ties) | 5 to 5 (9 ties) |

Mean judge scores (base / arm):
- sonnet-review: correctness 8.47 / 8.66, quality 8.34 / 8.39, scope 8.71 / 8.87, tests 6.68 / 6.55, security 8.89 / 9.13
- low-plan: correctness 8.63 / 8.66, quality 8.29 / 8.29, scope 8.74 / 8.82, tests 6.66 / 6.92, security 9.05 / 9.13

Sonnet-review won hard-deny-list, hard-memo-async, hard-redact-bugs, hard-shell-split, tb-dedup and wide-bug-hunt; base won hard-csv-stream, hard-edit-tiers, hard-ledger, hard-sse and hard-window. Low-plan won hard-ledger, hard-redact-bugs, hard-sse, hard-window and wide-bug-hunt; base won hard-deny-list, hard-edit-tiers, hard-memo-async, hard-pool and wide-three-features.

What it says:
- Neither cheaper arm lost quality that this suite can see: both are even with base on blind wins and within 0.25 on every mean score. The base column's scores differ between the two panels because each panel judged it again.
- A Sonnet review is the large saving: the review is the costliest step, and Sonnet at high effort costs less than half and takes a third less time. Per task the whole run comes to $0.177, under Claude Code alone on Opus ($0.206, `../2026-10-24-cc-baseline.jsonl`).
- A low-effort plan saves less money but cuts plan time by a third.
- Both together were not run. Adding the two savings gives about $0.14 per task (-45%); that is an estimate, not a measurement.

Caveats: one run per task, so a gap of one or two tasks is noise (`../2026-10-28-noplan/README.md`). The tasks are small. Sonnet reviews sent the writer back twice less often; on larger diffs a weaker review could miss more, and `real-*` tasks were not run.
