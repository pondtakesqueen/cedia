# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` points here.

## What this is

cedia is a personal coding harness written from scratch in TypeScript on Bun. `SPEC.md` holds every settled decision and the stage order; read it before changing scope. `docs/ROADMAP.md` says what comes next.

## Commands

- `bun test`: all tests. One file: `bun test test/layers.test.ts`. One test: add `-t "<name>"`.
- `bun run typecheck`: `tsc --noEmit`.
- `bin/cedia -p "<prompt>" [-m <model>] [--output-format text|json|stream-json] [--permission read-only|workspace] [--allow <rule>] [--deny <rule>]`: headless run. Read-only unless `--permission workspace`. `--check <cmd>` declares a check for the done gate. `--sandbox auto|on|off` controls the OS sandbox for bash (Linux needs bubblewrap, socat, ripgrep). `--fallback <ref|none>` names the model a run continues on when its quota runs out (default `deepseek` → `anthropic/claude-haiku-5-5`); `--on-quota wait:<min>` waits up to that long for a quota that says when it resets before falling back. `--plan <ref>` and `--review <ref>` add the plan and review roles (`claude-code[:<model>]` runs them in the user's own Claude Code); `roles` in `~/.cedia/settings.json` sets all three. `CEDIA_CLAUDE_BIN` points tests at a fake `claude`. Every run is a thread of the project: `--thread <id>` goes on with one, `--handoff-at <n|off>` sets when a long session hands off to a new one, `--spawn on|off` and `--swarm <ref>` control sub-threads.
- `bin/cedia threads [list [--all] | show <id> | send <id> <text> | unsend <id> [<msg>...] | rate <id> <up|down> | archive <id>]`: the project's threads.
- `bin/cedia --version --json`: version, protocol schema hash and capabilities, for clients.
- `bin/cedia lint-session <file.jsonl>...`: check a session log against the trust invariants. `-m faux` with `CEDIA_FAUX_SCRIPT=<steps.json>` runs offline.
- `bun scripts/protocol-schema.ts` regenerates `src/protocol/protocol.schema.json` after a protocol type changes; `bun scripts/session-fixtures.ts` re-records `test/fixtures/sessions/` after the output of a run changes. `test/fixtures.test.ts` fails when either is stale.
- `bun scripts/cache-probe.ts --model <ref> [--turns 20] [--runs 3]`: measure prompt-cache hits on a real model and name every miss.
- `bun evals/run.ts --harness <name> [--model <ref>] [--runs 3] [--jobs 4] [--budget <usd>] [--only <ids>] [--cedia-arg=<flag>]`: run the eval tasks against a harness; `--estimate --model <ref> [--measured <results.jsonl>]` prices a run first. Binaries come from `CEDIA_EVAL_<NAME>_BIN` or PATH. Results go in `evals/results/`.
- `bun evals/gate.ts [--model <ref>] [--estimate] [--update-baseline]`: the regression gate. Runs `evals/gate/suite.json`, prints the expected cost first, compares with `evals/gate/baseline/` and exits 1 when a model got worse. `--compare <results.jsonl>` re-scores a result file for free. Run it before merging a change to a prompt, default, the loop, a tool or the trust layer (`evals/gate/README.md`).

## How to work

Work the pstack poteto-mode way:

- Name the data shapes before writing logic.
- Prove it works: every done-criterion has a test or a command that reruns.
- Decide by experiment (prototype or eval) instead of asking when the question can be measured.
- Small commits, each one a unit that can be checked.

## Rules that are easy to get wrong

- `src/core` and `src/protocol` never import from `src/clients`. `test/layers.test.ts` enforces it.
- Model-visible means logged: anything that reaches the model is an event in the session log first.
- Keep the cached prefix byte-identical (see "Cache rules" in `SPEC.md`). Never edit message 0 mid-session.
- Every `tool_use` gets a `tool_result`, including denied and not-started calls.
- API keys only. Never add Claude.ai OAuth, Cursor login, or any request that impersonates another client.
- Never copy code or prompts from `anthropics/claude-code` (no license) or leaked sources, and never port cedia-rs. Adapted Apache-2.0/MIT code needs a `NOTICE` entry.
- e2e tests use the faux provider and must work offline.

## Research

- `research/NOTES.md`: distilled findings with source paths.
- `research/mirror-docs.sh`: re-downloads official docs into `research/docs/` (gitignored). Grep there before searching the web.
