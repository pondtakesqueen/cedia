# The writer's model and effort (2026-10-29)

Question: on the tasks Claude Code wins, its edge is reasoning before it writes (`../2026-10-29-cc-behavior/`). cedia's Haiku started at effort low. Does a higher effort, or Sonnet as the writer, give better changes, and at what cost?

- The writer ran alone (no plan, no review) on 12 tasks, one run each:
  - hard-memo-async, hard-pool, wide-bug-hunt, hard-redact-bugs, hard-injection, hard-deny-list
  - hard-ledger, hard-edit-tiers, hard-sse, hard-shell-split, hard-csv-stream, wide-three-features
- Command: `bun evals/run.ts --harness cedia --model <model> --runs 1 --only <tasks> --cedia-arg=--plan-when=never [--cedia-arg=--effort=<level>]`.
- **low**: the lines arm of `../2026-10-29-karpathy-lines/` (lines.jsonl and more/lines.jsonl), run earlier the same day on the same prompts. It was not run again.
- **medium**, **high**: Haiku 5.5 through opencode-go at that starting effort, from 0c92fa6.
- **sonnet**: Sonnet 5.5 through the Anthropic API at its default effort (high), from 0c92fa6. Its cost is real API spend.
- Panels: `judge-*/judge.py`, `claude -p` Sonnet, each pair in both orders. Only pairs where both passed and the diffs differ were judged. Side `cedia` is the arm named in the directory. Side `claude` is low for judge-medium and judge-high, and high for judge-sonnet.

| 12 tasks | Haiku low | Haiku medium | Haiku high | Sonnet |
|---|---|---|---|---|
| pass | 11/12 | 12/12 | 12/12 | 12/12 |
| cost, sum | $0.063 | $0.091 | $0.163 | $0.799 |
| wall time, sum | 410 s | 583 s | 1024 s | 449 s |
| turns, sum | 70 | 94 | 102 | 66 |
| blind | | **6 wins to 2** against low, 3 split | **7 wins to 1** against low, 3 split | 5 wins to 6 against high, 1 split |

Mean judge scores (arm / the side it was judged against):

| | correctness | quality | scope | tests | security |
|---|---|---|---|---|---|
| medium / low | 8.62 / 8.29 | 7.95 / 7.76 | 9.05 / 9.29 | 4.62 / 4.19 | 8.71 / 8.71 |
| high / low | 8.45 / 8.18 | 8.27 / 7.82 | 8.91 / 9.23 | 5.14 / 3.91 | 8.73 / 8.41 |
| Sonnet / high | 8.71 / 8.38 | 7.71 / 8.04 | 9.00 / 8.92 | 4.58 / 5.38 | 9.00 / 8.62 |

What it says:
- Effort is the cheap lever. Medium and high each beat low clearly, for under a cent more per task (medium) or about a cent (high). Scope drops a little as the changes grow.
- Haiku at high and Sonnet came out even:
  - Sonnet was more correct and more secure.
  - Haiku high wrote better tests and cleaner code.
  - Sonnet cost five times as much ($0.067 against $0.014 per task) and was the fastest (37 s against 85 s per task).
- The 2026-10-22 choice of low was made on pass rate alone, which cannot see these differences: low kept 48/48 on the gate suite.

Spent: $0.25 Haiku (opencode-go), $0.80 Sonnet (Anthropic API), panels $4.15 at API price on the owner's subscription.

## Against Claude Code (Opus), same 10 tasks

Blind panel (`judge.py`, both orders) against the Claude Code Opus diffs in `../2026-10-24-cc-baseline.jsonl`, run 1 of the 10 tasks in `judge-vs-cc/tasks.txt` (hard-redact-bugs and hard-shell-split changed since that baseline). Tally: `python3 judge-auto/tally.py <dir> <arm>`.

| cedia arm | cedia wins | CC wins | tie / split | tests (cedia / CC) | correctness | cost, 10 tasks | time, 10 tasks |
|---|---|---|---|---|---|---|---|
| Haiku medium alone (`judge-vs-cc/`) | 1 | 5 | 4 | 4.6 / 5.75 | 8.45 / 8.8 | $0.06 | 388 s |
| `-m auto`: Opus@low plan, Haiku medium, Sonnet@high review (`judge-auto/`) | **6** | 2 | 2 | **7.15 / 5.85** | 8.55 / 8.45 | $1.87 at API price ($0.10 Haiku + $0.96 plan + $0.81 review) | 1169 s |
| Claude Code, Opus | | | | | | $2.16 | 454 s |

- Both auto and CC passed 10/10. Auto won on tests most of all (the review sent 8 of 10 back, mostly for missing tests); CC still won hard-csv-stream and hard-memo-async.
- Auto costs 13% less than CC at API price, and the plan and review run in Claude Code on a subscription, so only $0.10 is billed per 10 tasks. It is 2.6 times slower: plan and review add about 70 s per task.
- One run per task, and the CC diffs are five days older than cedia's; the panel sees only diffs.
