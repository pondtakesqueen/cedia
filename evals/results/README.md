# Eval results

Raw rows from `bun evals/run.ts`, one JSON object per run. Summaries below are what the runner printed.

## 2026-10-21: first stage-2 baseline

12 tasks in `evals/tasks/` x 3 runs, each in a clean temp dir, cedia with `--permission workspace`, the OS sandbox on, and the task's verify command declared as `--check`.

| Model | Scored runs | pass@1 | pass^3 | False-done | Refused claims | Avg time | Tokens per run (in / out) | Cache hit | Cost |
|---|---|---|---|---|---|---|---|---|---|
| DeepSeek V4.1 Flash via Go | 35 (1 left out: provider error twice) | 100% | 100% | 0% | 0% | 19.0 s | 12,216 / 740 | 75.9% | $0.064 |
| Claude Haiku 5.5 via Anthropic API | 36 | 100% | 100% | 0% | 0% | 6.3 s | 9,493 / 796 | 79.6% | $0.026 |

Files: `2026-10-21-cedia-deepseek-flash.jsonl`, `2026-10-21-cedia-haiku-5-5.jsonl`.

What the first runs found before these numbers, both fixed in the same PR:

- DeepSeek's thinking mode rejects a tool-call turn replayed without `reasoning_content` when the model produced no reasoning that turn (`invalid_request_error`, 3 of 36 runs). The chat wire now sends the field as an empty string.
- The done gate refused 5 of 36 correct runs because the model ran `cd <working dir> && node test.js`. A leading `cd` to the working directory now counts, and the reminder says exactly what counts.

Reading: both models pass the whole set, so it cannot rank models or harnesses; it is the regression floor SPEC.md describes. Cache hit is lower than the cache probe's because these sessions are 3 to 8 requests long and the first request is a cold write.
