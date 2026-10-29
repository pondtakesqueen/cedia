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
- With the probe line, auto won 6 to 3 on run 1, and every judged pair agreed in both orders. Runs 2 and 3 did not hold it (below). It moved correctness past Opus high (8.8 / 8.4) and kept the lead on tests.
- The direct panel says part of that swing is the probe and part is run-to-run noise: probe against old is 4 to 3, with correctness the clearest gain. One run per task; read a two-win gap as noise.
- The probe did not cut the review's send-backs (8 of 10 in all three auto arms) or the time. auto is still about 1.8 times slower than Opus high (118 s against 65 s per task).
- Haiku at high on top of the probe was worse: fewer wins, 39% slower and 63% more Haiku spend. auto stays at medium.
- CC Opus high won hard-csv-stream and hard-memo-async in every panel, and hard-pool in two of three.

Spent: $0.27 Haiku (opencode-go). Claude Code Opus high ($2.56), plan and review ($3.22) and four panels ($5.60) ran at API price on the owner's subscription.

## Three runs per task (auto + probe against CC Opus high)

The 6-to-3 above was one run per task. Runs 2 and 3 of both sides: `auto-probe-r23.jsonl` and `cc-opus-high-r23.jsonl` (the files number them 1 and 2; the panel calls them 2 and 3). Panel: `judge-probe-r23/` (`judge.py` takes `RUNS=2,3`). Tally over all three runs: `python3 judge-probe-r23/tally.py judge-probe-r23 probe judge-probe`.

| 30 runs | wins / losses / tie or split | review sent back | time per task | cost per task at API price |
|---|---|---|---|---|
| runs 2 and 3 only | 7 / 12 / 1 | 14 of 20 | | |
| **runs 1 to 3** | **13 / 15 / 2** | 22 of 30 | 119 s against 70 s | $0.16 against $0.27 |

| runs 1 to 3 | correctness | quality | scope | tests | security |
|---|---|---|---|---|---|
| auto + probe / CC Opus high | 8.52 / 8.42 | 7.92 / 8.22 | 9.00 / 8.83 | 6.60 / 5.60 | 9.02 / 8.93 |

By task over three runs:
- CC Opus high won every run of hard-csv-stream, hard-memo-async and hard-pool.
- auto won every run of hard-ledger and hard-sse.
- The other five went both ways.

What it says:
- auto + probe is about even with Claude Code Opus at effort high, not ahead: 13 to 15. The one-run 6 to 3 was a lucky draw.
- Correctness is level (8.52 / 8.42). auto writes better tests (6.60 / 5.60). CC Opus high writes cleaner code (8.22 / 7.92).
- auto costs 40% less at API price, and only its Haiku ($0.01 per task) is billed. It is 1.7 times slower, and the review still sends 22 of 30 back.
- Where CC wins, it wins every time, on the same three tasks. That is the gap to work on, along with time.

Spent for this section: $0.19 Haiku (opencode-go). Claude Code Opus high ($5.43), plan and review ($3.02) and the panel ($2.78) ran at API price on the owner's subscription.

## The plan lists each rule and its test (three runs)

What CC Opus high did on the three tasks it always won (the panels' defects in `judge-probe*/verdicts-probe.json`):
- It tested each rule the doc comment states, not only the bugs it fixed.
- Its tests did not depend on timing.
- It compared a streaming function with the whole-input one across many inputs and splits.
- It made failures surface the way the code around them does: a promise API rejects instead of throwing, and errors carry the same offsets.

So the planner's prompt (`planPrompt`, `src/core/roles.ts`) now asks for:
- each rule, one line each, with the test that shows it holds (deterministic, a test per rule);
- a check against an existing version where there is one;
- how failures should surface.

The writer's prompt is unchanged from the probe arm.

- Run (`auto-rules.jsonl`): `bun evals/run.ts --harness cedia --model anthropic/claude-haiku-5-5 --review claude-code:sonnet@high --cedia-arg=--plan=claude-code:opus@low --runs 3 --jobs 2 --only <tasks>`. This is `-m auto` with the writer on the Anthropic API, because opencode-go's quota ran out partway through: same model, same starting effort (medium), a different route.
- Panel: `judge-rules/` against the same three CC Opus high runs, with a failed run left out. Tally: `python3 judge-rules/tally.py judge-rules rules`.

| 30 runs against CC Opus high | pass | wins / losses / tie or split | review sent back | time per task | cost per task at API price |
|---|---|---|---|---|---|
| auto + probe (above) | 30/30 | 13 / 15 / 2 | 22 of 30 | 119 s | $0.16 |
| **auto + probe + rule-listing plan** | 29/30 | **19 / 5 / 5** (6 losses counting the failed run) | 21 of 30 | 152 s | $0.18 |
| CC Opus high | 30/30 | | | 70 s | $0.27 |

| | correctness | quality | scope | tests | security |
|---|---|---|---|---|---|
| rule-listing plan / CC Opus high | 8.59 / 8.09 | 8.12 / 8.19 | 8.69 / 8.90 | 8.10 / 4.98 | 9.14 / 8.69 |

By task:
- auto now wins every run of hard-deny-list, hard-edit-tiers, hard-ledger, hard-sse and wide-bug-hunt.
- hard-pool went from three losses to three splits.
- CC still wins every run of hard-csv-stream, and both judged runs of hard-memo-async.
- hard-memo-async run 3 hit the 300 s limit before it finished.

What it says:
- Asking the planner for the rules and their tests is the biggest gain so far: 19 to 5, against 13 to 15 without it. The tests score rose from 6.60 to 8.10, and quality is now level with CC.
- It costs time: 152 s against 119 s per task (longer plans, reviews and fixes), and one run timed out. auto is now 2.2 times slower than CC Opus high.
- The writer ran on the Anthropic API here and on opencode-go in the probe arm. The model and effort are the same, but a run of the probe arm on the same route would rule the route out.

Spent for this section: $0.35 Haiku (Anthropic API). Plan and review ($5.17) and the panel ($4.32) ran at API price on the owner's subscription. The first attempt at this run stopped at 17 of 30 when opencode-go's quota ran out, and its results were not written.

## The plan also names states, where rules meet, and fast tests (three runs)

The rule-listing plan still lost hard-csv-stream and hard-memo-async (`judge-rules/verdicts-rules.json`):
- csv-stream: the stream kept parsing after a thrown error or after `end()`.
- memo-async: expired entries still counted toward the size limit, and a synchronous throw escaped as a throw.

It was also slower. Some of its tests ran large or timed loops, with tool time up to 187 s in a run, and one run timed out. So `planPrompt` now also asks for:
- the states the code passes through (after an error, after end or close, when reused) and where two rules meet;
- tests that finish in seconds and never wait on real time.

- Run (`auto-states.jsonl`): the same command and route as the rule-listing arm (Haiku on the Anthropic API).
- Panel: `judge-states/`, against the same three CC Opus high runs. Tally: `python3 judge-states/tally.py judge-states states`.

| 30 runs | pass | wins / losses / tie or split vs CC Opus high | review sent back | time per task (plan, review, fix) | tool time per run | cost per task at API price |
|---|---|---|---|---|---|---|
| rule-listing plan | 29/30 | 19 / 5 / 5 | 21 of 30 | 152 s (35, 39, 22) | 14 s | $0.18 |
| **+ states and fast tests** | **30/30** | **18 / 7 / 5** | **14 of 30** | **127 s** (36, 38, 9) | **1 s** | $0.20 |
| CC Opus high | 30/30 | | | 70 s | | $0.27 |

| | correctness | quality | scope | tests | security |
|---|---|---|---|---|---|
| states / CC Opus high | 8.53 / 8.42 | 8.08 / 8.18 | 8.87 / 8.93 | 8.07 / 5.17 | 9.05 / 9.02 |

What it says:
- Quality held: 18 to 7 here and 19 to 5 before are within a run's noise, and the score means are within 0.1 of each other.
- It is faster and steadier:
  - 16% less time per task;
  - no timeout;
  - tool time from 14 s to 1 s;
  - the review sent back 14 of 30 instead of 21, so the fix step fell from 22 s to 9 s.
- hard-csv-stream went from three losses to two and a split. hard-memo-async still loses every run, each time on expired entries that count toward the size limit.
- Plan and review are still most of the time (74 s of 127 s). They are the next place to look for speed.

Spent for this section: $0.30 Haiku (Anthropic API). Plan and review ($5.68) and the panel ($4.54) ran at API price on the owner's subscription.

## The plan checks defined words and puts new tests in a new file (three runs)

The planner's examples had come from two of these tasks (a streaming parser, an expiring cache), so they are now generic. The plan also:
- checks each place the code counts or reports a word the task or a doc comment defines (kept, used, done) against that definition;
- puts new tests in a new file when the task says to leave the existing ones alone (a plan had told the writer to append to them).

The writer's probe line keeps each added test fast (commit f30e1f5).

- Run (`auto-defs.jsonl`): the same command and route as the arms above.
- Panel: `judge-defs/`, against the same three CC Opus high runs. Tally: `python3 judge-defs/tally.py judge-defs defs`.

| 30 runs | pass | wins / losses / tie or split vs CC Opus high | review sent back | time per task (plan, review, fix) |
|---|---|---|---|---|
| states and fast tests | 30/30 | 18 / 7 / 5 | 14 of 30 | 127 s (36, 38, 9) |
| **+ defined words, new test file** | **30/30** | **22 / 5 / 3** | **10 of 30** | 140 s (35, 38, 7) |

| | correctness | quality | scope | tests | security |
|---|---|---|---|---|---|
| defs / CC Opus high | 8.82 / 8.43 | 8.12 / 8.22 | 8.67 / 8.95 | 8.42 / 4.98 | 9.22 / 9.10 |

What it says:
- hard-memo-async won a run for the first time: one win, one loss, one split.
  - No panel found expired entries counted toward the size limit any more.
  - The two losses were on a synchronous throw from `fn`, which escaped as a throw and, in one run, after the cache had already evicted entries.
- hard-pool lost two of three: the input array read live instead of snapshotted, and non-promise thenables adopted against the task's rule 3.
- The panels flagged a wall-clock assertion (`< 1000 ms`) in two memo runs as flaky.
- The time per task rose from 127 s to 140 s. The full test suite ran beside this eval for four minutes, so part of that rise is the machine, not the arm.

Spent for this section: $0.31 Haiku (Anthropic API). The panel ($4.69) and the plan and review ran at API price on the owner's subscription.

## One finishing order for the writer, and a review that goes rule by rule (three runs)

The thorough writer prompt (any writer that works from a plan) had lines that pulled against each other:
- "Prefer the smallest change" read as "the fewest lines" against rules no visible test held.
- "When the task lets you change tests" read as "never" when the task said to leave the existing tests alone.
- The stop line came before the probe and the diff read, so a run could stop before either.

The thorough writer now gets its own versions of those lines, and a numbered finishing order: check, probe, read the diff, check again, stop. Each step says why the order matters. The wording follows Anthropic's prompting guide (`claude-prompting-best-practices`: "Be clear and direct" on sequential steps, "Add context", "Overeagerness" and "Avoid focusing on passing tests"). The diff read keeps what makes a stated rule hold, the state after an error included. The frugal prompt is byte-identical (`test/prompts.test.ts`).

The review now starts with the rules: each rule the task and the touched doc comments state, one line each, with the line that makes it hold or the input that breaks it.

- Run (`auto-order.jsonl`): the same command and route as the arms above.
- Panel: `judge-order/`, against the same three CC Opus high runs. Tally: `python3 judge-order/tally.py judge-order order`.

| 30 runs | pass | wins / losses / tie or split vs CC Opus high | review sent back | time per task (plan, review, fix) |
|---|---|---|---|---|
| defined words, new test file | 30/30 | 22 / 5 / 3 | 10 of 30 | 140 s (35, 38, 7) |
| **+ finishing order, rule-by-rule review** | **30/30** | **23 / 6 / 1** | 17 of 30 | 148 s (34, 46, 14) |

| | correctness | quality | scope | tests | security |
|---|---|---|---|---|---|
| order / CC Opus high | 8.85 / 8.20 | 8.07 / 8.18 | 8.62 / 8.95 | 8.62 / 4.93 | 9.15 / 8.75 |

What it says:
- hard-memo-async lost no run for the first time: two wins and a split. The one panel that went to CC was on a synchronous throw from `fn`.
- hard-csv-stream lost all three, every time on the same point: the stream reads one character per call, where Claude Code scans runs with `indexOf` and `slice`. That is the next arm: the plan names the shape of new code.
- hard-pool lost two again: the input array read live, and non-promise thenables adopted against rule 3. Two of its four losing panels named no defect in cedia's change and preferred CC's tests.
- wide-three-features lost one run on rules the task states (spaces, not all whitespace; the raw input in the error), which the rule-by-rule review did not catch.
- It costs time: the rule-by-rule review takes 46 s instead of 38 s and sends back 17 of 30, so a task takes 148 s.

Spent for this section: $0.36 Haiku (Anthropic API). The panel ($4.66) and the plan and review ran at API price on the owner's subscription.

## The plan gives the shape of new code (three runs)

hard-csv-stream lost every panel of the last arm on one point: the stream read one character per call, where Claude Code scanned whole runs with `indexOf` and `slice`. The planner now names the shape of the code the change adds:
- where input is large or arrives in pieces, scan whole runs with what the language provides instead of one item per call;
- keep state in as few fields as the rules need, each named for what it means;
- give each new type or function a doc comment that says what it keeps and what happens after an error.

The code around the change is left as it is.

- Run (`auto-shape.jsonl`): the same command and route as the arms above.
- Panel: `judge-shape/`, against the same three CC Opus high runs. Tally: `python3 judge-shape/tally.py judge-shape shape`.

| 30 runs | pass | wins / losses / tie or split vs CC Opus high | review sent back | time per task (plan, review, fix) |
|---|---|---|---|---|
| finishing order, rule-by-rule review | 30/30 | 23 / 6 / 1 | 17 of 30 | 148 s (34, 46, 14) |
| **+ shape of new code** | 28/30 | **23 / 3 / 2** (of 28) | 14 of 30 | 159 s (38, 45, 14) |

| | correctness | quality | scope | tests | security |
|---|---|---|---|---|---|
| shape / CC Opus high | 8.86 / 8.27 | 8.14 / 8.18 | 8.64 / 8.86 | 8.54 / 4.86 | 9.27 / 8.95 |

What it says:
- hard-csv-stream went from three losses to two losses and a tie. No panel named a per-character scan any more; every panel called both streams linear per chunk. The losses were on Claude Code's tests (every split, a row returned as soon as it ends) and its explicit state machine.
- hard-pool went from two losses to one win, one loss and a tie.
- Correctness is the highest of any arm (8.86 against 8.27).
- hard-memo-async failed two of three runs. Each time a test the writer added awaited a promise that never settled, so the check hung until the run's time ran out.
  - Six more runs of that task alone (`auto-shape-memo6.jsonl`) all passed, so it is 7 of 9 with this plan.
  - The earlier arms passed it 9 of 9.
  - It is not counted here as caused by this line, but a hung test can still cost a run.

Spent for this section: $0.34 + $0.06 Haiku (Anthropic API). The panel ($4.39) and the plan and review ran at API price on the owner's subscription.
