# Where DeepSeek Flash's extra turns go (vs-claude round, 2026-10-22)

Runs: arm C (cedia, `opencode-go/deepseek-v4.1-flash`) and arm D (`claude -p`) from `2026-10-22-vs-cedia-flash.jsonl` and `2026-10-22-vs-claude-p.jsonl`, on main `5237104`. Read-only analysis of the session logs; nothing was re-run.

Sources:

- cedia: `~/.cedia/sessions/<eval cwd>/<id>.jsonl` (one per run).
- Claude Code: `~/.claude/projects/<eval cwd>/<id>.jsonl`.

The script is `turns.py` in the analysing session's scratchpad. Its counting rules are below the table.

## Counts per run

| harness | task | run | session file | turns | tool calls | no tool | 1 call | 2+ calls | read whole | read range | re-reads | bash reads | test runs | piped test runs | failed edits | failed bash |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cedia | hard-redact-bugs | 1 | 7e6b50ea | 26 | 31 | 2 | 17 | 7 | 2 | 3 | 3 | 14 | 5 | 3 | 3 | 2 |
| cedia | hard-redact-bugs | 2 | 3f2b500e | 23 | 21 | 3 | 19 | 1 | 2 | 1 | 1 | 9 | 6 | 3 | 0 | 2 |
| cedia | hard-shell-split | 1 | 85f506cd | 15 | 15 | 2 | 11 | 2 | 2 | 1 | 1 | 4 | 5 | 1 | 0 | 2 |
| cedia | hard-shell-split | 2 | 3af02fbf | 17 | 17 | 1 | 15 | 1 | 2 | 2 | 2 | 3 | 5 | 1 | 0 | 1 |
| cedia | real-slop-guard | 1 | d2e0215d | 48 | 66 | 3 | 24 | 21 | 8 | 5 | 3 | 34 | 16 | 12 | 0 | 2 |
| cedia | real-slop-guard | 2 | c4a97fea | 87 | 96 | 3 | 72 | 12 | 0 | 4 | 1 | 46 | 29 | 24 | 1 | 7 |
| claude | hard-redact-bugs | 1 | aae5f4b0 | 6 | 5 | 1 | 5 | 0 | 1 | 0 | 0 | 3 | 4 | – | 0 | 0 |
| claude | hard-redact-bugs | 2 | d29e6a33 | 6 | 5 | 1 | 5 | 0 | 1 | 0 | 0 | 4 | 4 | – | 0 | 0 |
| claude | hard-shell-split | 1 | bd0a277f | 5 | 4 | 1 | 4 | 0 | 1 | 0 | 0 | 2 | 1 | – | 0 | 1 |
| claude | hard-shell-split | 2 | a7f94948 | 5 | 5 | 1 | 3 | 1 | 1 | 0 | 0 | 2 | 1 | – | 0 | 1 |
| claude | real-slop-guard | 1 | bfb081ac | 15 | 15 | 1 | 13 | 1 | 1 | 0 | 0 | 10 | 3 | – | 0 | 0 |
| claude | real-slop-guard | 2 | 4385d6eb | 11 | 11 | 1 | 9 | 1 | 0 | 0 | 0 | 9 | 3 | – | 0 | 0 |

Counting rules:

- **Turn:** one model reply. Claude Code writes one reply as several lines that share a `message.id`; those lines are grouped into one turn.
- **Read:**
  - *read whole* and *read range* count calls to the `read`/`Read` tool, where *range* means an `offset` or `limit` was given.
  - *re-reads* count `read` calls on a file that was already read in the same run.
  - *bash reads* count bash commands containing `cat`, `sed -n`, `head`, `tail`, `od`, `base64` and similar.
- **Test runs:**
  - *test runs* count bash commands containing `bun test`, `tsc` or `bun run typecheck`.
  - *piped test runs* count `bun test` runs combined with a pipe, `;` or `&&`. cedia's done gate does not count those as evidence; Claude Code has no done gate.
- **Failures:** *failed edits* and *failed bash* count results with a non-completed status (cedia) or `is_error` (Claude Code).

Turns per task, cedia against Claude: 23–26 against 6, 15–17 against 5, and 48–87 against 11–15.

Most turns hold a single tool call in both harnesses: 158 of 216 for cedia and 39 of 48 for Claude. Parallel calls are not where the gap comes from. Claude needs fewer turns because its calls do more each, for example `ls && cat redact.ts && bun test | tail` in one call and one patch for all the bugs. It also hits none of the harness frictions below.

## Patterns

### 1. Harness reminders after "done" restart the run, and some are false positives

The slop guard and the done gate fire after the model's final report. 54 of cedia's 216 turns come after its first no-tool "done" turn; Claude has 0.

| run | first done | reminders | extra turns |
|---|---|---|---|
| real-slop-guard#2 | T51 | slop guard at T51, then done gate at T77 | 26 + 10 = 36 |
| real-slop-guard#1 | T43 | slop guard, then done gate at T45 | 5 |
| hard-redact-bugs#2 | T17 | slop guard, then done gate at T21 | 6 |
| hard-redact-bugs#1 | T21 | slop guard | 5 |
| hard-shell-split#1 | T13 | done gate | 2 |

Several slop flags are false positives:

- **The English word "any" in a comment:**
  - In `hard-redact-bugs` (both runs) the guard reported `type-escape redact.ts`.
  - The flagged line is a comment: "// - a dotenv line (`export NAME=value` at the start of a line): any value that is not a bare number".
- **The slop detector's own regex literals:**
  - In `real-slop-guard` (both runs) the guard reported `suppression` and `stub` in `src/core/trust/slop.ts`.
  - The flagged lines are its pattern constants, such as `const SUPPRESSION = /@ts-ignore|...eslint-disable.../`, and a comment that mentions `as any`.
  - In run 2 this alone accounts for T52–T76.

The done-gate reminders exist because the model ran `bun test 2>&1 | tail`/`| grep` (1–24 piped runs per run) instead of plain `bun test`. It then had to re-run the test suite plainly: real-slop-guard#2 T78 and T84–T86, and hard-shell-split#1 T14.

### 2. In cedia's sandbox, the repository's own tests fail before any change (real-slop-guard)

Six tests fail under cedia's sandbox with `EPERM: operation not permitted, lstat '/Users/pond/.ssh'`. The failing tests are in `test/policy.test.ts` (the "credential stores" test) and `test/headless.test.ts` (the "text output" tests).

Claude Code's runs saw `191 pass, 0 fail` on their first full `bun test`. cedia's runs saw `179 pass 7 fail`, then `180 pass 6 fail`, then `185 pass 6 fail`.

Run 2 chased these failures through T20–T28, T31–T47, T63–T72 and T78–T83. Its first fully green suite came at T84, after it rewrote `real()` in `src/core/safety/policy.ts` (T82) so that an EPERM from `realpathSync` no longer throws. Run 1 edited `policy.ts` too, at T18 and T29.

The underlying issue is real outside the eval. When the sandbox forbids a stat, `policy.ts` `real()` throws. A real run that hits that path ends without a tool result.

Also sandbox-related: writes to `/tmp` are denied (1–3 times per run). Each denial costs a turn. For example, hard-shell-split#2 T8 wrote `/tmp/probe.ts` (`Operation not permitted`), and T9 wrote it again in the working directory.

### 3. Output redaction hides the very text the redact task is about (hard-redact-bugs)

cedia's `read` returns the test fixtures with `[cedia:redacted]` in place of the fake secrets. The model notices this in run 1 (T4 thinking: "The `read` tool applied its own redaction to the output!").

It then spends T3–T8 on ways to see the real bytes: `cat -A`, `od -c`, `base64`, `base64 -d | sed` and two `node -e` dumps. Its first three edits fail to match (T9, T10, T11), because `old_text` was rebuilt from the redacted view. The fourth (T12) lands.

Run 2 shows the same redacted results, 6 times. Claude Code has no output redaction; it `cat`s the file in T1 and patches with one Python script in T3.

### 4. Fix one thing, test, repeat; then keep going after green

cedia fixes and tests in small steps. In hard-shell-split#2 the sequence is edit (T4), test (T5, 1 fail), edit (T6), test (T7, 7/7 green).

After green it goes on for 9 more turns:

- an edge-case probe script (T8–T9, the first attempt blocked by `/tmp`)
- an unrequested improvement for quoted redirect targets (T10–T11)
- re-reads of `shell.ts` (T12, T14)
- `command -v tsc` (T13) and `ls -la` (T16), which repeat environment checks like T3's `which bun && bun --version`

Claude Code in the same task does one edit plus a test in T3 and one probe in T4, then reports.

Test runs per run: cedia 5–29, Claude Code 1–4.

### 5. Reading in pieces after the first pass (real-slop-guard)

The first pass is not the problem: run 2 read about 20 files in T1–T7 with compound `cat` commands, two per turn.

Afterwards, cedia goes back for slices with `sed -n a,bp` or `read @offset+limit`, one per turn:

- run 2: T14, T16, T32, T37–T39, T43, T49, T52, T66, T80
- run 1: 5 ranged reads, 3 re-reads and 34 bash reads in 48 turns

Claude Code made no ranged reads and no re-reads in either run.

## What this suggests (not yet measured)

The patterns split into fixes for cedia itself and fixes for the Flash model profile.

Fixes for cedia, which would also help Haiku:

- **Slop-guard false positives (pattern 1):** match `any` only in type positions, skip string and regex literals and comments, and skip the detector's own file.
- **Sandbox robustness (pattern 2):** make `policy.ts` `real()` survive EPERM, and have the eval sandbox treat a stat on `~/.ssh` as a denial instead of an error. This one fix accounts for most of real-slop-guard#2's loss.
- **Redaction in the redact task (pattern 3):** decide whether `read` should redact files inside the working directory. Today the redact task is impossible to see clearly, by design. This is a security trade-off for the owner to decide.

Fixes for the Flash profile (prompt delta), for patterns 1, 4 and 5:

- Finish with exactly the declared check, unpiped.
- Fix every failure the first test run shows before re-running.
- Stop when the declared check passes; no extra probes or features.
- Batch follow-up reads into one compound command.

Pattern 1's slop and done-gate turns, pattern 2's sandbox chase and pattern 3's redaction detour are harness-caused. Without them, about a third of cedia's 216 turns across these six runs would not happen; the exact share needs a re-run.
