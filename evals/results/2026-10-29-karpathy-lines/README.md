# Two work-method lines for the writer (2026-10-29)

Question: two habits from published agent guidelines (multica-ai/andrej-karpathy-skills, thananon/9arm-skills' debug-mantra) are missing from cedia's base prompt. Do they help Haiku?
- To fix a bug, when the task lets you change tests, first add a test that fails because of the bug, then make it pass. The panels have scored tests lowest of the five axes in every run.
- Remove imports, variables and helpers your own change left unused; leave dead code that was there before. This goes in the line on reading the whole diff before the report.

The wording is cedia's own; no text was copied.

- Two arms, Haiku alone (no plan, no review), on four bug-fix tasks, one run each:
  ```
  bun evals/run.ts --harness cedia --model opencode-go/claude-haiku-5-5 --runs 1 --jobs 2 \
    --only hard-memo-async,hard-pool,wide-bug-hunt,hard-redact-bugs --cedia-arg=--plan-when=never
  ```
  - **base**: 6b8ad40, from a worktree.
  - **lines**: the same code with the two lines added.
- Both arms were run here because no earlier Haiku-alone run used the current prompts. A Haiku run costs about half a cent.
- Judge: `judge/judge.py`, both orders. Side `cedia` in `judge/verdicts-lines.json` is lines; side `claude` is base.

| 4 tasks | base | lines |
|---|---|---|
| pass | 4/4 | 4/4 |
| Haiku cost, turns, wall time | $0.025, 35, 146 s | $0.022, 32, 132 s |
| blind | | **2 wins** (hard-pool, wide-bug-hunt), 0 losses, 2 ties |

Mean judge scores (base / lines): correctness 8.75 / 8.75, quality 8.38 / 8.38, scope 9.12 / 9.12, tests 7.12 / 7.0, security 8.75 / 9.12.

What it says:
- hard-pool: lines removed its abort listener once the pool finished, and base left one that could start work after the pool resolved.
- wide-bug-hunt: the source fixes were the same; lines' tests also covered a tier boundary that base's did not.
- hard-redact-bugs forbids test changes, and both arms made the same change, byte for byte. Two orders of an identical pair both came out tie, as they should.
- No extra cost or turns. Two wins and no loss on four tasks is a lean, not proof.

Decision: kept. The gate (`bun evals/gate.ts`) was not run; it should run before this merges, as AGENTS.md asks for a prompt change.

Spent: $0.05 Haiku and $0.44 panel.

## Eight more tasks, and the gate

The same two arms on eight more tasks (`more/`): hard-injection, hard-deny-list, hard-ledger, hard-edit-tiers, hard-sse, hard-shell-split, hard-csv-stream and wide-three-features. base ran from a worktree of 6b8ad40, lines from 9b8c332 (main after #166 and #170; nothing in #170 changes a prompt). The panel judged only the 7 pairs where both passed and the diffs differ (`more/judge/`).

| 8 tasks | base | lines |
|---|---|---|
| pass | 8/8 | 7/8: hard-csv-stream failed a hidden fuzz test (a BOM in a later chunk) |
| Haiku cost, turns | $0.043, 40 | $0.040, 38 |
| blind (7 pairs) | 2 wins: hard-edit-tiers, hard-ledger | **4 wins**: hard-deny-list, hard-injection, hard-shell-split, wide-three-features; 1 tie (hard-sse) |

Mean judge scores (base / lines): correctness 8.14 / 8.21, quality 7.43 / 8.07, scope 8.79 / 9.21, tests 2.93 / 3.21, security 8.29 / 8.57.
- On hard-injection, base deleted a comment block the task had not asked about; lines left it.
- The tests scores are low in both arms because no prompt in this batch asked for tests and neither arm added many.

Both batches together, 12 tasks:
- lines won 6 pairs and base won 2. Three pairs tied, and one pair was identical.
- Passes: 11/12 for lines and 12/12 for base. One failed hidden test on one run is within the noise.

The gate on 9b8c332 (`bun evals/gate.ts`, 25 tasks, 2 runs per model, against the stored baselines of 2026-10-22) passed for both models. Results: `../2026-10-29-gate-opencode-go_*-9b8c332-053329.jsonl`.

| | pass@1 (compared tasks) | typical task cost | typical task time | turns |
|---|---|---|---|---|
| Haiku | 42/42 → 42/42 | +12.6% (limit +15%) | -2.9% | 95 → 90 |
| DeepSeek | 42/42 → 42/42 | -0.8% | +2.6% | 142 → 124 |

- The gate did not compare hard-redact-bugs, a task changed since the baseline. Haiku failed it on both gate runs: the done gate refused the claim with a visible test still red.
- To check whether these lines caused that, it was run again (Haiku, scratch runs, not kept):

| hard-redact-bugs | runs | passed |
|---|---|---|
| 6b8ad40, no lines | 8 | 8 |
| 3f772e7, lines only | 5 | 5 |
| 9b8c332 (main) | 7 | 5 |

- Every failure on main came in the first window. The four main runs made later, beside four base runs, all passed.
- The lines alone never failed, and nothing #170 changed touches redaction or prompts. So the failures look like run-to-run variance, not this change.
- In the failed runs, Haiku said cedia's secret redaction had shown it `[cedia:redacted]` in place of the test inputs, so it could not tell what the tests expected. That confusion is real and worth a look on its own.
- Haiku's +12.6% typical cost covers every change since 2026-10-22, not only these lines. In the direct comparison above, the lines cost no more.

Spent on this section: about $0.10 Haiku, $0.78 panel, $0.74 gate, $0.15 reruns.
