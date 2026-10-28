# Roadmap

The order the work goes in from here, agreed on 2026-10-21. `SPEC.md` holds the decisions and the stage list; this file says what comes next and what "done" means for each step.

The order follows two rules. Measure before changing: the regression gate comes before any change it would judge, so every later step lands with numbers. Trust before features: a harness that can be left alone has to be safe and stable before it gets more to do.

## 1. Close open work (done)

PRs #15 to #18: real-repository eval tasks, results on Haiku 5.5, DeepSeek V4.1 Flash and Beam, the 429 quota fix, the 200-turn default, and the first fixes from the Claude Code changelog review.

## 2. Regression gate (done: baselines in `evals/gate/baseline/`)

`bun evals/gate.ts` runs a fixed suite on each model, records pass rate, false-done, cost and time, compares them with the baseline stored for that model, and exits 1 when one got worse. How it decides, and what it costs, is in `evals/gate/README.md`.

Done when: baselines for Haiku 5.5 and DeepSeek V4.1 Flash are stored; a second run on the same commit passes against them; the offline test (`test/gate.test.ts`) shows a broken harness fails.

From here on:

- A PR that changes a prompt, a default, the loop, a tool or the trust layer runs the gate before merge and puts its report in the PR description.
- A PR meant to move the numbers (a new default, a cheaper path) runs `--update-baseline` in the same PR and says why the new numbers are the right ones.
- A PR that changes a gate task invalidates that task's baseline; the gate leaves it out until the baseline is updated.

## 3. Security and stability (P1 from `research/NOTES.md`) (done)

Fixed in #17 and #18: frame tags, bash process groups, hooks directories, the bounded tool pool and sub-thread cap, ref-losing git commands, and the redaction misses. Then, each with a faux test:

- Malformed turns (`c7fb551`): a thinking-only reply, a tool name over 200 characters, a tool result that is not a string, unparseable calls alternating with `max_tokens`, shared call ids. An abort between two calls of a reply leaves the rest `not_started` instead of running them past the stop.
- History refused by the API, thinking signatures included (`e7b8a79`): the run goes on in a new session from a note, as quota fallback does.
- Redaction on long token-like text runs in linear time (`test/secrets.test.ts`).
- Sandbox exit codes: a failing declared check inside the sandbox ends the run `error_unverified_claim` with exit 1 under bash, zsh and sh as the login shell (`test/headless.test.ts`).
- Large bash output goes whole to a redacted file with a preview of its start and end, instead of losing its middle at 30k characters (SPEC "Tool output").

## 4. Make spawn work

No model has called `spawn` in any of 30+ real-repository runs. The "Spawn และความเร็ว handoff" work adds a one-time reminder and a fallback for explore sub-threads when Beam's quota is out.

Done when: a model spawns on its own on the `real-*` tasks, and spawn on beats spawn off on cost or time without a lower pass rate, measured with the gate (`--cedia-arg=--spawn=off` against the default).

Status (2026-10-22): with the reminder (#21), Haiku spawns on its own on every `real-*` task. On `real-three-changes` (three real commits in one task) it sends explore sub-threads and then one work sub-thread per part, and spawn on costs half of spawn off ($0.06 against $0.08 to $0.13 a run) at 100%, but takes longer (work sub-threads run one at a time). Work sub-thread handoff is checked on a real model by `real-three-delegated`, now in the gate suite. DeepSeek Flash still never spawns. Left: spawn on Flash, and the time cost of work sub-threads (`evals/results/README.md`, 2026-10-22).

## 5. UX and new features

`SPEC.md` stages 3 to 6, in order: the TUI on pi-tui with `/diff`, `/undo` and the status line; AGENTS.md, full compaction, memory, `/commit` and `/pr`; skills, MCP, subagents by role and the first four-arm comparison; rewind, LSP, goal mode, the classifier and the full eval against pi, `claude -p` and `codex exec`. The cost ideas in `research/NOTES.md` (cold-thread resume, staggered parallel agents, TTL per role) are measured with the gate as they come up.

Each feature lands with its gate report, like any other change.

## 6. What the desktop (cedian v1) needs from cedia

Agreed with the owner on 2026-10-28 (cedian `docs/CEDIAN_SPEC.md` §11 holds the order). Each lands like any other change, with its gate report when it touches a prompt, a default, the loop or a tool.

- Phase B: a lock the desktop's daemon holds and `cedia daemon` yields to; images on `threads send` and `threads fork`; an inline-edit command (a selection and an instruction, answered with a diff).
- Phase C: multi-repo workspaces as SPEC describes them (`--thread` runs in the thread's root, memory and schedules keyed by the primary root's slug, extra read-only roots); the `Artifact` tool and `enableArtifact`; a write to the project's files.
- Phase D: a completion command for tab completion (fill-in-the-middle on a fast, cheap model); the route for prompt images and video frames.
