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

## 2026-10-21: review role

Same seven hard tasks, 3 runs each, Haiku 5.5 on the Claude API writing. With `--review anthropic/claude-sonnet-5-5`, Sonnet reads the change after the done gate passes, and changes it asks for go back to Haiku once.

| Setup | pass@1 | pass^3 | Reviews asking for changes | Avg time | Tokens per run (in / out) | Cost | Cost per passed run |
|---|---|---|---|---|---|---|---|
| Haiku alone | 100% | 100% | - | 58.5 s | 116,920 / 12,215 | $0.195 | $0.009 |
| Haiku + Sonnet review | 100% | 100% | 6 of 21 | 93.9 s | 188,886 / 16,424 | $1.324 | $0.063 |

Files: `2026-10-21-hard-cedia-haiku-5-5-rerun.jsonl`, `2026-10-21-hard-cedia-haiku-5-5-review-sonnet.jsonl`.

- The verify commands cannot show what review adds: Haiku already passes every run, so the review costs 6.8x for the same score. What it adds shows in its findings, not the pass rate. Reading the first round's reviews found two real cedia bugs that no test caught, both fixed: an allow rule covered `echo x > f` in read-only mode, because the split argv drops redirections; and a numeric dotenv password (`DB_PASSWORD=12345678`) went out unredacted.
- A first round (not kept) ran before reviewers could run the declared checks, so every test run they tried was denied. In this round reviewers ran a check 38 times; 38 other calls were still denied, mostly `bun -e` probes to confirm a finding. A disposable copy of the workspace would let them run those.
- Reading: keep review for changes where a missed bug costs more than about $0.05 a run, and measure it again on a task set that Haiku does not saturate.

## 2026-10-21: sub-threads and handoff

Same seven hard tasks, 3 runs each, Haiku 5.5 writing. Three arms run side by side: the `spawn` tool off; on (the default, explore sub-threads on beam); and off with `--handoff-at 20000`, far below the 150k default, to force handoffs on tasks this small.

| Setup | pass@1 | pass^3 | Sub-threads / handoffs | Avg time | Tokens per run (in / out) | Cost | Cost per passed run |
|---|---|---|---|---|---|---|---|
| spawn off | 95.2% | 85.7% | - | 54.9 s | 109,601 / 11,793 | $0.187 | $0.009 |
| spawn on | 95.2% | 85.7% | 0 sub-threads | 50.9 s | 114,325 / 10,685 | $0.174 | $0.009 |
| handoff at 20k | 90.5% | 85.7% | 10 handoffs in 6 runs | 82.0 s | 95,705 / 15,647 | $0.240 | $0.013 |

Files: `2026-10-21-hard-cedia-haiku-5-5-spawn-off.jsonl`, `2026-10-21-hard-cedia-haiku-5-5-spawn-on.jsonl`, `2026-10-21-hard-cedia-haiku-5-5-handoff-20k.jsonl`.

- The spawn tool costs nothing measurable when unused, and Haiku did not spawn on any of these tasks: each is a few files, which the tool's description says to do yourself. Its value has to be measured on tasks with wide searches or independent parts.
- The one failure in both spawn arms is `hard-redact-bugs#1`, a refused claim (no passing check after the last change), as in earlier rounds.
- Handoff works end to end on a real model: 4 of the 6 runs that handed off passed, and the notes (2.7k to 4.5k characters) name the done condition, each change with its line, the checks run, and traps to avoid. Both failures hit the eval's 300 s run timeout on `hard-shell-split`, the longest task, after 1 and 2 handoffs. Forced this early, handoff cut input by 13% but added a third more output (the notes, and re-orienting), so it cost 28% more. It pays only when a session's context is large, which is why the default is half the window, at most 150k: none of these tasks gets near it.

## 2026-10-21: wide tasks and hidden tests

Four new tasks meant to be wider and longer than the hard set: `wide-bug-hunt` (four pricing-rule violations in a 25-file service, one of them a region table that drifted from the README), `wide-deprecate` (remove `oldLog` from 20 modules, with an alias, a re-export, a dynamic level and multiline calls), `wide-three-features` (three independent modules from their comments) and `long-migrate` (ten callback handlers to async/await). 3 runs each, Haiku 5.5 writing, the same three arms as above, except handoff at 30k.

| Setup | pass@1 | pass^3 | Sub-threads / handoffs | Avg time | Tokens per run (in / out) | Cost | Cost per passed run |
|---|---|---|---|---|---|---|---|
| spawn off | 100% | 100% | - | 38.5 s | 98,510 / 8,138 | $0.084 | $0.007 |
| spawn on | 100% | 100% | 0 sub-threads | 33.0 s | 79,547 / 7,115 | $0.072 | $0.006 |
| handoff at 30k | 91.7% | 75.0% | 0 handoffs | 46.3 s | 93,598 / 7,412 | $0.076 | $0.007 |

Files: `2026-10-21-wide-cedia-haiku-5-5-{spawn-off,spawn-on,handoff-30k}.jsonl`, with each run's printed summary in the matching `.log`.

- The first versions of these tasks had visible tests that named every bug; a pilot passed 4 of 4 in 10 to 33 s for under a cent each. So a task directory may now hold `hidden/`: tests laid over the workspace only at verify. `wide-bug-hunt` became a vague report ("some totals do not match README.md") with its hand-worked tests hidden, and `wide-three-features` keeps a few examples in sight while every rule is checked hidden.
- Haiku 5.5 still found all four bug-hunt violations in every run, the drifted table included.
- Hidden tests caught three places where the module comments did not say what the tests expected (a diacritic the list left out, spaces around a duration, whether expired entries count toward capacity). Each failing run had read the comment as written, so the comments were fixed, not the tests. The one failure above is the last of those three, before its fix.
- No run spawned and none handed off, even at 30k: the runs took 4 to 11 turns and their context stayed under it. The arms differ by noise, not by setup (all three are the same harness on these runs). These tasks do not exercise sub-threads or handoff; that needs a real repository with a task that spans many files, where one session's context grows past 100k.

## 2026-10-21: real repository (cedia's own history)

Three tasks that redo real commits of this repository from their parent (`evals/tasks/real-*/`): `real-threads` (8d44c2a: threads, handoff, recall, thread messages; 8 source files), `real-subthreads` (4ead389: the spawn tool; 9 files) and `real-slop-guard` (7009c5a: the slop guard and detected checks; 8 files). The workspace is the tree at the parent, about 100k to 125k tokens, with the commit's own new tests in sight; verify is the whole `bun test` suite. Haiku 5.5 on the Claude API writing, 2 runs per task and arm, 1200 s per run. A public repository (hono) was the first choice, but running its code here was refused, and the tasks only reach models allowed for private code.

| Setup | pass@1 | Peak context, mean (max) | Runs past 100k | Sub-threads / handoffs | Avg time | Output tokens per run | Cost | Cost per passed run |
|---|---|---|---|---|---|---|---|---|
| spawn off, handoff off | 100% | 157k (211k) | 5 of 6 | - | 381 s | 76,939 | $1.758 | $0.293 |
| spawn on, handoff off | 100% | 130k (173k) | 4 of 6 | 0 sub-threads | 305 s | 61,923 | $1.300 | $0.217 |
| handoff at 90k | 83.3% | 103k (114k) | 4 of 6 | 19 handoffs | 665 s | 135,803 | $1.027 | $0.205 |
| handoff at 90k, only after a change | 83.3% | 125k (162k) | 4 of 6 | 16 handoffs | 614 s | 125,980 | $1.156 | $0.231 |

Per task, mean cost per run (spawn off / spawn on / handoff / handoff after a change): `real-slop-guard` $0.059 / $0.041 / $0.069 / $0.053, `real-subthreads` $0.313 / $0.263 / $0.125 / $0.193, `real-threads` $0.507 / $0.346 / $0.320 / $0.332.

Files: `2026-10-21-real-cedia-haiku-5-5-{spawn-off,spawn-on,handoff-90k,handoff-90k-changed-first}.jsonl`, with each run's printed summary in the matching `.log`.

- Context does grow past 100k on a real codebase: 5 of 6 single-context runs did, up to 211k, where every request costs Haiku's long-context price (5x).
- Haiku never spawned, in any of 6 runs, even at 170k. The two arms run the same behaviour, so the 26% cost gap between them is noise; at 2 runs a task, differences under about a quarter mean nothing here.
- Handoff at 90k halves the cost of the larger tasks (`real-subthreads` $0.31 to $0.13-0.19), but nearly doubles wall time and output (each new session re-reads what it needs, and writes a note), and costs more on the small task. Both failures are `real-threads` hitting the 1200 s limit after 5 handoffs, not wrong work.
- Requests still went past 100k in handoff runs: the size is checked after a turn, so a turn that reads several files jumps past the price line, and the note request carries the whole context.
- The first pilot found a real bug: the bash tool dropped `GIT_CONFIG_KEY_n` as secret-looking but kept `GIT_CONFIG_COUNT`, so every git command in a tool call failed; the count, keys and values now go together. And it showed that the agent's sandbox cannot open another sandbox inside it, so the repo tasks skip that one test inside it (verify still runs it).
- In the first handoff round, 12 of 19 handoffs came from sessions that had changed no file (by the evidence ledger), and the failed run handed off five times in a row without a change, then timed out. A session now hands off only after it has changed a file: none of the 16 handoffs in the second round came before a change. Pass rate and cost stayed within noise; peaks rose, since a session now reads on past 90k until its first change.
- Reading: on a codebase this size handoff is the lever that pays, at the price of time; spawn has no measured value until the model uses it. Next: hand off before a turn would cross the price line rather than after, and test whether a reminder at high context gets Haiku to spawn explore sub-threads.

## 2026-10-21: real repository on DeepSeek V4.1 Flash and Beam

The three `real-*` tasks above, 2 runs per task and arm, measured at 80e9643 (main after the Haiku round, before any later spawn or handoff change). DeepSeek V4.1 Flash and Beam (free) via Go, off-peak for DeepSeek. Single context is `--handoff-at off` with spawn on; handoff is `--handoff-at 90000` with spawn on. Haiku rows are copied from the round above.

| Model, setup | pass@1 | Runs at the 50-turn cap | Peak context, mean (max) | Runs past 100k | Handoffs | Avg time | Output tokens per run | Cost | Cost per passed run |
|---|---|---|---|---|---|---|---|---|---|
| Haiku 5.5, single context | 100% | 0 of 6 | 130k (173k) | 4 of 6 | - | 305 s | 61,923 | $1.300 | $0.217 |
| Haiku 5.5, handoff at 90k (after a change) | 83.3% | 0 of 6 | 125k (162k) | 4 of 6 | 16 | 614 s | 125,980 | $1.156 | $0.231 |
| Flash, single context | 66.7% | 5 of 6 | 125k (142k) | 6 of 6 | - | 431 s | 49,391 | $0.386 | $0.096 |
| Flash, handoff at 90k | 83.3% | 2 of 6 | 96k (112k) | 2 of 6 | 7 | 528 s | 68,322 | $0.585 | $0.117 |
| Flash, single context, `--max-turns 200` | 100% | 0 of 6 | 138k (171k) | 4 of 6 | - | 629 s | 58,801 | $0.597 | $0.099 |
| Beam, single context | 66.7% | 6 of 6 | 69k (86k) | 0 of 6 | - | 198 s | 26,059 | $0 | $0 |
| Beam, handoff at 90k | 50.0% | 6 of 6 | 68k (80k) | 0 of 6 | 0 | 237 s | 25,273 | $0 | $0 |

Per task, mean cost per run on Flash (single / handoff / 200 turns): `real-slop-guard` $0.054 / $0.060 / $0.068, `real-subthreads` $0.072 / $0.113 / $0.123, `real-threads` $0.067 / $0.119 / $0.108.

Files: `2026-10-21-real-cedia-deepseek-flash-{spawn-on,handoff-90k,turns-200}.jsonl` and `2026-10-21-real-cedia-beam-{spawn-on,handoff-90k}.jsonl`, each with its `.log`.

- The default of 50 turns per session is what failed these models, not their work. Haiku finishes in 23 to 40 turns; Flash takes 60 to 102 and Beam hit 50 in all 12 runs. Every Flash and Beam failure but one is `error_max_turns`. The handoff arm passes more because each new session gets 50 turns of its own. With `--max-turns 200` Flash passed 6 of 6.
- At that cap Flash passes like Haiku at under half the cost ($0.099 against $0.217 per passed run), and takes twice as long (629 s against 305 s). It writes a little less, but reads in many short turns.
- Handoff does not pay on Flash: DeepSeek has no long-context price, so a 170k request costs the same per token as a 20k one, and the 200-turn single context costs the same as handoff at 90k. Handoff's saving on Haiku comes from staying under Haiku's 100k price line.
- Neither model spawned, in any of 30 runs, so spawn is still unmeasured on every model tried.
- Beam stops at 50 turns before its context reaches 90k, so it never handed off. The free tier then ran out: a 200-turn Beam round got `429 Rate limit exceeded` with retry-after 27380 s (7.6 h), and is not in the table.
- That 429 found a cedia bug: the session slept on the retry-after, and the eval's SIGTERM at the run limit could not wake it, so three runs hung past their 1200 s. A 429 asking for more than 10 minutes now counts as spent quota (no retry, the fallback applies), and abort ends a retry wait (e0d9080).
- The one Flash failure that was not the cap (`real-threads#2`, handoff) made the threads tests pass and broke a sandbox test in `test/headless.test.ts`.
- Reading: the 50-turn default suits Haiku but cuts off models that take smaller steps; raising it, or counting work instead of turns, would let the cheaper model finish. On a provider without a long-context price, handoff buys nothing but time.

## 2026-10-21: spawn reminder and handoff that carries the plan

The same three `real-*` tasks on Haiku 5.5, 2 runs per task and arm, 3 at a time, against the PR #15 rows above. Two changes: a writer that has spawn and has not used it gets one reminder when its context passes a third of its handoff point (30k for Haiku), and the handoff note now carries the plan for what is left while the new session is told to follow it instead of planning again.

| Setup | pass@1 | Peak context, mean (max) | Runs past 100k | Sub-threads / handoffs | Avg time | Output tokens per run | Cost | Cost per passed run |
|---|---|---|---|---|---|---|---|---|
| before: spawn off, handoff off | 100% | 157k (211k) | 5 of 6 | - | 381 s | 76,939 | $1.758 | $0.293 |
| before: handoff at 90k | 83.3% | 103k (114k) | 4 of 6 | 19 handoffs | 665 s | 135,803 | $1.027 | $0.205 |
| handoff at 90k, note carries the plan (spawn off) | 100% | 128k (158k) | 5 of 6 | 8 handoffs | 394 s | 83,700 | $0.844 | $0.141 |
| spawn reminder (handoff off) | 100% | 101k (125k) | 4 of 6 | 23 sub-threads | 334 s * | 68,827 | $0.797 | $0.133 |
| both (the default) | 100% | 101k (126k) | 3 of 6 | 19 sub-threads, 1 handoff | 416 s * | 69,424 | $0.666 | $0.111 |

\* Excluding one run per arm that hung on a bug, not the setup (below). The default arm's hung `real-threads#2` was rerun once (`-default-nudge-plan-rerun`) and that row replaces it here.

Per task, mean cost per run (plan handoff / spawn reminder / both): `real-slop-guard` $0.052 / $0.040 / $0.039, `real-subthreads` $0.179 / $0.183 / $0.200, `real-threads` $0.191 / $0.175 / $0.093.

Files: `2026-10-21-real-cedia-haiku-5-5-{handoff-90k-plan,spawn-nudge,default-nudge-plan,default-nudge-plan-rerun}.jsonl` with `.log`. Measured on the branch before it was rebased onto the bounded tool pool and sub-thread limit (#17), which none of these runs came near.

- Where handoff time went: a diagnostic run of `real-threads` at 90k (session logs kept) showed every new session re-reading about 30k tokens of code, then thinking for 30k to 40k tokens (2 to 3 minutes at 250 tok/s) to plan the whole task again, writing one file and being back at 90k, since that thinking stays in its context. Five handoffs meant five plans, and the run hit its 1200 s limit. With the plan in the note, handoffs per run fell from 3.2 to 1.3, no run timed out, and time dropped from 665 s to 394 s, about the same as no handoff (381 s), at under half its cost.
- Peaks still pass 100k in handoff runs: one reply that plans (40k to 50k thinking tokens) can take a session from 90k to 150k in a turn, before the boundary where handoff is checked.
- With the reminder, Haiku spawned in every run that finished (42 sub-threads in 12 runs, against none in 18 runs before). It usually sends 2 to 5 explore sub-threads in parallel, then often one `work` sub-thread with the whole implementation. A work child has no handoff, so it is where the default arm's runs went past 100k (`real-subthreads` at $0.20).
- Beam's free tier ran out mid-eval (retry-after 6.7 to 7.8 h). The default arm's explore sub-threads ran on Beam; in the spawn-reminder arm and the rerun all 24 fell back to Haiku through the new quota fallback for explore, so that arm paid for its exploring and the two are not a clean comparison of spawn alone.
- Two bugs hung runs, both fixed on main by #16 and #17: the session slept on Beam's multi-hour retry-after, and a bash timeout killed bash but not a script it started, which kept the pipes open (one run hung 75 minutes).
- Reading: both changes pay, and together they give the lowest cost per passed run measured on these tasks ($0.111, against $0.293 with neither and $0.205 with the old handoff) at about the old single-context time. Next: give work sub-threads the same handoff as the writer, and check the handoff point before a planning reply rather than after it.

## 2026-10-22: a long task with three parts, and sub-thread handoff on a real model

The gate never had a sub-thread long enough to hand off, so nothing showed that work sub-thread handoff (04c196a) triggers on a real model. Two new tasks redo three real commits at once from 32774a7: `real-three-changes` (c7fb551 malformed turns, e7b8a79 refused history, 14264ef quota wait; the three parts listed, their tests in `test/loop.test.ts`, `test/headless.test.ts` and `test/policy.test.ts`, verify the whole `bun test`) and `real-three-delegated`, the same task with one sentence more: hand the whole change to one work sub-thread, then run the tests. The workspace has no git history, so both skip the one gate test that loads the suite's real-repository task. Haiku 5.5 on the Claude API (handoff at 90k, its default), DeepSeek V4.1 Flash via Go (150k), 1800 s per run. Run results now carry `spawned` (sub-threads by kind, their handoffs, their peak context), and `peakContext` is the run's own sessions' only.

| Model, task, setup | pass@1 | Runs | Peak context (own) | Sub-threads | Handoffs (own / in sub-threads) | Turns past 100k per run | Avg time | Cost per run |
|---|---|---|---|---|---|---|---|---|
| Haiku, three-changes, spawn on | 100% | 2 | 77k (94k) | 9 (3 work), peak 55k | 1 / 0 | 0 | 386 s | $0.056 |
| Haiku, three-changes, spawn off | 100% | 2 | 135k (145k) | - | 2 / - | 4, 4 | 293 s | $0.128 |
| Haiku, three-delegated | 100% | 2 | 11k (13k) | 2 (2 work), peak 132k | 0 / 2 | 5, 2 | 357 s | $0.128 |
| Flash, three-changes, spawn on | 100% | 2 | 103k (103k) | 0 | 0 / 0 | 4, 1 | 280 s | $0.056 |
| after the change below: | | | | | | | | |
| Haiku, three-changes, spawn on | 100% | 3 | 65k (76k) | 17 (7 work), peak 68k | 0 / 0 | 0 | 549 s | $0.062 |
| Haiku, three-changes, spawn off | 100% | 3 | 108k (120k) | - | 4 / - | 1, 1, 2 | 319 s | $0.084 |
| Haiku, three-delegated | 100% | 3 | 10k (13k) | 3 (3 work), peak 115k | 0 / 4 | 2, 1, 2 | 363 s | $0.092 |

Files: `2026-10-22-long-cedia-haiku-5-5-{spawn-on,spawn-off,delegated}.jsonl`, the same with `-readonly-handoff` after the change, and `2026-10-22-long-cedia-deepseek-flash-spawn-on.jsonl`, each with its `.log`.

- Sub-thread handoff works on a real task: in all 5 delegated runs the work sub-thread passed 90k, wrote its note, went on in a new session of its own thread and finished, and the parent's own context stayed at 9k to 13k. The parent ran the tests after it in every run; all passed.
- Haiku now spawns on its own on a task with independent parts: 10 of 26 sub-threads in the spawn-on runs were `work`, typically one per part after a few explore sub-threads, and none went past 68k, under the handoff point. Spawn on cost half of spawn off ($0.056 to $0.062 against $0.084 to $0.128) at the same pass rate, and took longer (386 to 549 s against 293 to 319 s): work sub-threads run one at a time, and each reads its part again.
- DeepSeek Flash did not spawn in either run, as on every task before; it passes for the same cost as Haiku with spawn.
- What the runs found: a session handed off only after it had changed a file, and Haiku reads a whole part before its first edit, so its first session read on past 90k, to 101k-141k before its handoff request (writer and work sub-thread alike), paying the long-context price on every turn past 100k, then handed off right after that edit anyway. The rule was there because, before notes carried the plan, sessions that had only read handed off to successors that read everything again, five in a row on one run. It now holds only for a session that picked up from another; a first session may hand off having only read, with its plan and the line ranges to read. Turns past 100k fell from 4 to 1-2 per run (what is left is the turn that jumps past the line, and the note), and cost fell by a third with spawn off and by 28% delegated, at 100% in all runs. No session handed off twice without a change; first sessions now ask for the note at 93k to 112k, after one turn that jumps 15k to 30k (a few whole files read at once).
- The runs also showed, by reading the code, that a sub-thread's spend did not count against the run's budget while its parent ran: each had up to the whole remaining budget. It is now metered across the run's sessions as each turn ends (faux test in `test/threads.test.ts`).
- Keep-alive, checked on 2 more delegated runs (`-delegated-keepalive`, both passed, $0.066 a run): each parent sent one refresh about 4 minutes after its spawn request, which read its whole prefix from the cache (2.8k and 7.1k tokens, exactly what the spawn request had read and written), and its next request read that prefix again instead of writing it. Before, 6 of 6 parents that waited past 5 minutes wrote their context again. On Haiku's small parents this is cents; it matters for a large parent on Opus or Sonnet.
- The gate on this branch (24 shared tasks, 2 runs, both models): PASS. Haiku 47/48 (the one failure is `hard-redact-bugs#1`, a refused claim, as in earlier rounds), typical task cost -0.9%, time +0.5%. Flash 48/48, typical task cost -5.9% at one price, time +1.8%. The Flash run started at DeepSeek's peak hours and first read +63% for the whole set against an off-peak baseline, so the gate now compares a model with an off-peak price at its standard price. Files: `2026-10-22-gate-*-26ffc46-dirty-004336.jsonl`; the baseline rows for `real-three-delegated` are `2026-10-22-gate-*-82363a0-dirty-011126.jsonl` (Haiku $0.07 a run, 1 sub-thread handoff in each; Flash $0.15-0.18 at peak price, no handoff below its 150k point).
- Reading: spawn pays on cost on long multi-part tasks, at some cost in time; handoff pays on Haiku when it fires before the 100k price line. `real-three-delegated` joins the gate suite, so every gate run checks that a work sub-thread hands off and finishes.
