# cedia auto against Claude Code Opus at effort high (2026-10-29)

Question: `-m auto` beat Claude Code Opus at its default effort 6 to 2 (`../2026-10-29-haiku-effort/`). Does it still win against Opus at effort high? And does a writer that probes its own change for edge cases before the review (`PROBE_THOROUGH`, `src/core/prompts.ts`) win more, get sent back less, or finish sooner?

- Tasks: the same 10 as `../2026-10-29-haiku-effort/judge-auto/tasks.txt`, one run each.
- **CC Opus high** (`cc-opus-high.jsonl`): Claude Code 2.1.312, `bun evals/run.ts --harness claude --model opus` with `CEDIA_EVAL_CLAUDE_BIN=claude-effort-high.sh` (adds `--effort high`), `CEDIA_EVAL_RUN_BUDGET=3`.
- **auto, old**: `../2026-10-29-haiku-effort/auto.jsonl`, reused (57e7c90, no probe line).
- **auto + probe** (`auto-probe.jsonl`): `bun evals/run.ts --harness cedia --model auto --runs 1 --jobs 2 --only <tasks>`, with the probe line.
- **auto + probe, Haiku high** (`auto-probe-high.jsonl`): the same with `--cedia-arg=--effort=high`.
- Panels: `judge.py` as in `../2026-10-29-haiku-effort/` (`claude -p` Sonnet, blind, each pair in both orders; a win counts when both orders agree). Tally: `python3 judge-<arm>/tally.py judge-<arm> <arm>`. In every panel side `claude` is CC Opus high, except `judge-probe-vs-old/`, where it is the old auto.

| 10 tasks | pass | wins / losses / tie or split against CC Opus high | review sent back | time, sum | cost at API price |
|---|---|---|---|---|---|
| CC Opus high | 10/10 | | | 652 s | $2.56 |
| auto, old (`judge-old-auto/`) | 10/10 | 2 / 4 / 4 | 8 of 10 | 1169 s | $1.87 ($0.10 Haiku + $0.96 plan + $0.81 review) |
| **auto + probe** (`judge-probe/`) | 10/10 | **6 / 3 / 1** | 8 of 10 | 1183 s | $1.69 ($0.10 + $0.81 + $0.78) |
| auto + probe, Haiku high (`judge-probe-high/`) | 10/10 | 4 / 3 / 3 | 8 of 10 | 1644 s | $1.80 ($0.17 + $0.78 + $0.85) |

Mean judge scores (cedia arm / CC Opus high):

| | correctness | quality | scope | tests | security |
|---|---|---|---|---|---|
| auto, old | 8.30 / 8.55 | 8.00 / 8.30 | 8.80 / 9.10 | 6.85 / 5.90 | 9.10 / 8.65 |
| auto + probe | 8.80 / 8.40 | 7.85 / 8.30 | 8.90 / 9.00 | 7.20 / 5.75 | 9.35 / 8.85 |
| auto + probe, Haiku high | 8.30 / 8.35 | 7.90 / 8.15 | 8.75 / 9.05 | 7.40 / 5.45 | 9.20 / 8.60 |

Head to head, auto + probe against the old auto (`judge-probe-vs-old/`): 4 wins to 3, 3 split; correctness 8.95 / 8.30, tests 7.50 / 6.90.

What it says:
- Against Opus at effort high, the old auto lost 2 to 4. Opus high was more correct; auto won on tests and security.
- With the probe line, auto won 6 to 3, and every judged pair agreed in both orders. It moved correctness past Opus high (8.8 / 8.4) and kept the lead on tests.
- The direct panel says part of that swing is the probe and part is run-to-run noise: probe against old is 4 to 3, with correctness the clearest gain. One run per task; read a two-win gap as noise.
- The probe did not cut the review's send-backs (8 of 10 in all three auto arms) or the time. auto is still about 1.8 times slower than Opus high (118 s against 65 s per task).
- Haiku at high on top of the probe was worse: fewer wins, 39% slower and 63% more Haiku spend. auto stays at medium.
- CC Opus high won hard-csv-stream and hard-memo-async in every panel, and hard-pool in two of three.

Spent: $0.27 Haiku (opencode-go). Claude Code Opus high ($2.56), plan and review ($3.22) and four panels ($5.60) ran at API price on the owner's subscription.
