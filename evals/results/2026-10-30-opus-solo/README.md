# Opus 5.5 at medium writing alone in cedia, against Claude Code Opus xhigh (2026-10-30)

The question: does cedia's harness make Opus on its own as good as Claude Code at effort xhigh? On 2026-10-28, Opus in cedia lost 1-8 (10 ties) to Claude Code Opus at its default effort (`../2026-10-28-opus-quality/`).

- Run: `bun evals/run.ts --harness cedia --model anthropic/claude-opus-5-5 --runs 1 --jobs 2 --only <the 10 tuning tasks>`, cedia at 8eb3486, no plan or review, sandbox unavailable in the container (bash unsandboxed), Opus at its default effort (medium) with `OPUS_PROMPT`. Run 1 did all 10 tasks; run 2 stopped after 7 when the $3 owner budget was nearly spent (`cedia-opus-med-r{1,2}.*`).
- Baseline: the 30 Claude Code Opus xhigh runs from `../2026-10-30-plan-habits/cc-xhigh/` (PR #207), run i against Claude Code run i.
- Panels: `judge/judge.py` (Sonnet) and `judge/opus/` (`JUDGE_MODEL=opus`), each pair judged twice with sides swapped. `notx.py` decides without the tests score.

| 17 pairs vs Claude Code Opus xhigh | pass | without tests (cedia / CC / split or tie) | with tests | correctness (cedia / CC) | time per task | API spend per task |
|---|---|---|---|---|---|---|
| **cedia, Opus medium alone** | 17/17 | Sonnet 5 / 3 / 9, Opus 3 / 7 / 7 | Sonnet 6 / 7 / 4, Opus 4 / 9 / 4 | 8.44 / 8.56, 8.35 / 8.76 | 56 s | $0.16 |
| `-m auto` (30 pairs, `../2026-10-30-plan-habits/main/`) | 30/30 | 4 / 10 / 16 both panels | 19-9, 18-10 | 8.62 / 8.42, 8.67 / 8.72 | 158 s | $0.012 (+ plan and review on the subscription) |
| Claude Code Opus xhigh | 30/30 | | | | 142 s | ~$0.52 at list price |

The code itself, checked by running probes on every side (`probes/`, saved as `.ts.txt` so `tsc` skips them; rename and run `bun <probe> <patched dir>`):

- No side has a bug that must be fixed before merging. Every run passed the hidden tests.
- hard-csv-stream: Opus passes the same 1.7M-case fuzz against `parseCsv` as every other run, at Claude Code's speed (cedia auto runs 1 and 3 were 2-4x slower).
- hard-memo-async: 20k misses at max 20000 take 18-24 ms for Opus, like Claude Code (18-33 ms); cedia auto runs 1-2 took 5.6 s. Opus run 1 lets a synchronous throw from `fn` escape as a throw (as Claude Code run 3 and auto run 1 do); Opus run 2 drops a live key on it (as Claude Code run 2 does).
- hard-pool: Opus throws TypeError, not RangeError, for a Symbol or null-prototype limit, and reads the caller's task array live, as auto does; Claude Code validates and copies.
- hard-ledger: Opus run 2 accepts `cd /w/r&&bun test` like Claude Code; run 1 does not, like auto.
- hard-deny-list: Opus run 2 also denies `rm -rf .*`, which the reference allows (stricter, not unsafe).
- wide-three-features: Opus rounds `0.5005s` to 500 and drops `ǿ`, as auto runs 1-2 do; Claude Code runs 2-3 give 501 and `o`.
- wide-bug-hunt: Opus's source change is the same as Claude Code's.
- Non-test lines added, summed over the tasks' mean runs: Opus 543, auto 544, Claude Code 623.

What it says:
- Opus alone in cedia is now about level with Claude Code xhigh on the code (one panel 5-3, the other 3-7, most pairs split or tied), where on 2026-10-28 it lost 1-8 to Claude Code at default effort. The task sets and baselines differ (19 tasks against default effort then, 10 against xhigh now), so read the change as direction, not size.
- Without tests it does better than `-m auto` against the same baseline, and at 56 s a task it is 2.8 times faster than auto and 2.5 times faster than xhigh, at about a third of xhigh's list price.
- Where Claude Code still wins, it is input validation and copies of caller-owned input (hard-pool), and structure on hard-csv-stream; correctness means are within 0.4.
- 17 pairs: a gap of two or three wins is noise.

Spent: $2.75 Opus 5.5 on the Anthropic API. Panels ran through Claude Code.
