# The writer reads while the plan is written (2026-10-28)

Question: does `--plan-overlap on` (#162) cut a run's time and keep quality?

- Both arms: `bun evals/run.ts --harness cedia --model opencode-go/claude-haiku-5-5 --runs 1 --jobs 2 --review claude-code:opus@medium --cedia-arg=--plan=claude-code:opus@medium` on the 19 non-`real-*` tasks of `../2026-10-28-noplan/`, plan-when auto, isolated `CEDIA_HOME`. Arm **on** adds `--cedia-arg=--plan-overlap=on`. The two arms ran at the same time on one machine, so they shared its load and the subscription's limits.
- Haiku went through opencode-go: in this cloud container the egress proxy did not authenticate OpenRouter at all (with or without a key in the request), so the provider differs from the noplan arm's.
- Judge: `judge/judge.py` (a copy of `evals/judge/tpl6-claude-p/judge.py`), `claude -p` Sonnet, each pair in both orders; a win counts only when both orders agree. Side `cedia` in `judge/verdicts-on.json` and `judge/mapping-on.json` is **on**; side `claude` is **off**.

| | overlap off | overlap on |
|---|---|---|
| pass@1 | 18/19 (hard-memo-async hit the 300 s run limit) | 19/19 |
| wall time, sum of 19 | 2265 s | 2085 s (-8%) |
| the same without hard-memo-async | 1965 s | 1950 s (-1%) |
| Haiku turns, sum | 127 | 169 |
| Haiku cost | $0.114 | $0.125 |
| Opus sessions (plans + reviews) | 15 + 14 | 15 + 15 |
| review sent the writer back | 9 | 12 |
| blind wins | 2 | **9** (8 ties) |

Mean judge scores (off / on): correctness 8.29 / 8.74, quality 8.24 / 8.11, scope 8.92 / 8.84, tests 6.39 / 6.97, security 8.84 / 8.92.

On won hard-csv-stream, hard-deny-list, hard-ledger, hard-memo-async (off failed it), hard-redact-bugs, hard-window, tb-dedup, wide-bug-hunt and wide-three-features. Off won hard-shell-split and wide-deprecate. Without hard-memo-async it is 8 to 2.

What it says:
- Time: no real saving. The 8% comes from off's one timed-out run; without it the arms are within 1%. The writer does not sit idle any more, but it spends the time reading (169 turns against 127), and after the plan arrives it still does the same work.
- Quality: better, mostly on correctness (+0.45) and tests (+0.58). A plausible reason, not checked: the writer reads the code on its own before it sees the plan, so it has more of the code in context when it follows the plan, and it can tell where the plan is wrong.
- Cost: about 10% more Haiku spend (more turns, more cached input), and the same number of Opus sessions.

Caveats: one run per task, so a difference of one or two tasks is within the noise seen before (`../2026-10-28-noplan/README.md`); 9 to 2 is well past that. The tasks are small; on long tasks the reading before the plan could cost more context.

Verdict: turn it on by default for its quality, not its speed. The regression gate (`evals/gate/suite.json`) sets no plan role, so overlap changes nothing there.
