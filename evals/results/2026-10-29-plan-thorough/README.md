# Thorough stop lines for a writer that works from a plan (2026-10-29)

Question: Haiku's system prompt tells it to stop once a check passes and to skip extra edge cases (`STOP_FRUGAL`, `src/core/prompts.ts`). An Opus plan often lists the edge cases to handle, and the blind panels kept marking cedia down on edge cases and tests. Does a planned writer do better with the stop lines Opus gets (`STOP_THOROUGH`, no turn-cost line)?

- The change: when a run will be planned, the writer's session opens with the thorough system prompt (`fromPlan` in `src/clients/headless/main.ts`). It is set before that session starts, so the cached prompt never changes mid-session. A message the triage sends straight to the writer keeps the frugal lines.
- One arm, 5 tasks, one run each, the same roles as the sonnet-review arm of `../2026-10-29-cheaper-opus/`:
  ```
  bun evals/run.ts --harness cedia --model opencode-go/claude-haiku-5-5 --runs 1 --jobs 2 \
    --only hard-sse,hard-window,hard-ledger,hard-memo-async,hard-redact-bugs \
    --review claude-code:sonnet@high --cedia-arg=--plan=claude-code:opus@medium
  ```
- Baseline: the sonnet-review arm's runs of the same tasks, not run again. Base beat that arm on three of these tasks (sse, window, ledger) and lost on two (memo-async, redact-bugs), so the pick is not only tasks it lost.
- Judge: `judge/judge.py`, both orders. Side `cedia` in `judge/verdicts-thorough.json` is this arm; side `claude` is sonnet-review.

| 5 tasks | sonnet-review (before) | thorough lines |
|---|---|---|
| pass | 5/5 | 5/5 |
| Haiku cost, turns | $0.033, 55 | $0.032, 49 |
| run cost with plan and review | $0.896 | $0.935 (+4%, plan variance) |
| wall time, sum | 636 s | 473 s (memo-async alone: 272 s to 121 s) |
| review sent the writer back | 3 | 3 |
| blind | | 1 win (memo-async), 1 loss (sse), 3 split |

Mean judge scores (before / thorough): correctness 8.4 / 8.9, tests 6.1 / 6.6, quality 8.0 / 7.7, scope 9.1 / 8.8, security 9.3 / 8.9.

What it says:
- No cost: Haiku spent the same and took fewer turns.
- The scores moved the way the hypothesis says (correctness and tests up half a point) and the other way on quality, scope and security. On memo-async, the one clear win, the writer handled expired entries and sync throws the plan named. On sse, the one loss, it left an unguarded `reader.cancel()`.
- One win and one loss on five tasks is within the noise (`../2026-10-28-noplan/README.md`). This shows the change is not worse; it does not show it is better.

Decision: kept, since it costs nothing and moved the axes it aimed at. A larger run (all 15 planned tasks, about $3) would settle it.

Spent: $0.94 runs (API price; the plan and review drew on a subscription) and $0.55 panel.
