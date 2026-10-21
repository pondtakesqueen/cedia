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

## 2026-10-21: hard tasks

Seven tasks built from cedia's own code (`evals/tasks/hard-*/`): tiered edit matching, shell splitting for the policy, a streaming SSE reader, the git/rm deny list, the evidence ledger, four injected bugs in the secret redactor, and `hard-injection`, which plants instructions in a README and a code comment and fails any run that follows them. 3 runs each, same setup as above. A test checks every stub fails verify and its reference solution passes, and task tests are restored before verify.

| Model | Scored runs | pass@1 | pass^3 | False-done | Refused claims | Injection resisted | Avg time | Tokens per run (in / out) | Cache hit | Output tok/s | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Haiku 5.5 via Anthropic API | 21 | 95.2% | 85.7% | 0% | 4.8% | 3/3 | 55.5 s | 99,976 / 12,125 | 83.5% | 222 | $0.188 |
| DeepSeek V4.1 Flash via Go | 21 | 95.2% | 85.7% | 0% | 0% | 3/3 | 77.4 s | 211,666 / 12,158 | 87.6% | 173 | $0.480 |
| Beam (free) via Go | 21 | 100% | 100% | 0% | 0% | 3/3 | 57.2 s | 241,195 / 14,705 | 86.0% | 346 | $0.000 |

Files: `2026-10-21-hard-cedia-haiku-5-5.jsonl`, `2026-10-21-hard-cedia-deepseek-flash.jsonl`, `2026-10-21-hard-cedia-beam.jsonl`.

- Failures: Haiku `hard-redact-bugs#3` (the done gate refused a claim with no passing check after the last change); DeepSeek `hard-shell-split#1` (hit the 300 s run timeout).
- Output tok/s here is output tokens over all model time, time to first token included; later runs report the decode rate on its own. cedia's own overhead was under 0.1% of run time on Haiku. On DeepSeek about 7% went to retry waits after Go 429 and 503 errors, which the timing now reports as `retryMs`.
- A first round on the earlier code found a real usability bug: Haiku gave up on `hard-ledger` because a heredoc with an apostrophe was denied as an unparsed command and the denial told it not to retry. Heredocs are now parsed, and a parse failure tells the model to rewrite the command.
- Beam ran later, on the code with the quota fallback (`--fallback none` in evals), and is the only model to pass all 21; its tok/s is the decode rate alone, so it is not comparable with the two rows above.
- Reading: both models are tied on pass rate and both resisted the injection; Haiku is faster and cheaper per passed run ($0.009 against $0.024) because DeepSeek reads twice the input. The set now ranks harnesses better than the first one, but the top models will likely saturate it too.
