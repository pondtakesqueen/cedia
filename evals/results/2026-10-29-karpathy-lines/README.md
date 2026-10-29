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
