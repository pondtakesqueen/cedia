# Haiku writes, Opus reviews, no plan (2026-10-28)

Question: does dropping the plan role keep quality while cutting time and Opus calls?

- Arm **noplan**: `bun evals/run.ts --harness cedia --model openrouter/claude-haiku-5-5 --runs 1 --jobs 3 --review claude-code:opus@medium` on the 19 non-`real-*` tasks (`cedia-haiku-or-review-only.jsonl`). No plan role (isolated `CEDIA_HOME`).
- Arm **plan**: the same 19 rows of `../2026-10-24-p25-cedia-scope.jsonl` (anthropic/claude-haiku-5-5, plan and review `claude-code:opus@medium`, plan-when auto).
- Judge: `evals/judge/tpl6-claude-p/judge.py`, `claude -p` Sonnet, each pair in both orders, a win only when both orders agree. In `verdicts-noplan.json` and `mapping-noplan.json`, side `cedia` is noplan and side `claude` is plan.

| | plan + review | review only |
|---|---|---|
| pass@1 | 19/19 | 19/19 |
| wall time, sum of 19 | 2301 s | 1796 s (-22%) |
| Haiku API cost | $0.131 | $0.125 |
| Opus sessions (claude-code) | 34 (15 plans + 19 reviews) | 19 reviews |
| review sent the writer back | 10 | 13 |
| blind wins | **8** | 4 (7 ties) |

Mean judge scores (plan / noplan): correctness 8.63 / 8.42, quality 8.21 / 8.39, scope 8.84 / 8.92, tests 7.13 / 6.55, security 9.00 / 8.84.

Plan won hard-csv-stream, hard-edit-tiers, hard-memo-async, hard-redact-bugs, hard-sse, hard-window, long-migrate, wide-three-features. Review-only won hard-deny-list, hard-ledger, tb-dedup, wide-deprecate. The five simple tasks tied (plan-when auto already skips the planner on four of them).

Caveats: one run per task; the writer's provider differs (OpenRouter pins Bedrock, the p25 arm used the Claude API), same model. In this cloud container the egress proxy drops OpenRouter's `Authorization: Bearer`, so the run used a local, uncommitted change sending the key as `x-api-key` (OpenRouter's Messages endpoint takes either).

Verdict: dropping the plan saves about a fifth of the time and 15 Opus sessions, but loses more hard tasks than it wins, mostly on correctness and tests. Keep `--plan-when auto`.
