# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` points here.

## What this is

cedia is a personal coding harness written from scratch in TypeScript on Bun. `SPEC.md` holds every settled decision and the stage order; read it before changing scope. `docs/ROADMAP.md` says what comes next.

## Commands

- `bun test`: all tests. One file: `bun test test/layers.test.ts`. One test: add `-t "<name>"`.
- `bun run typecheck`: `tsc --noEmit`.
- `bin/cedia -p "<prompt>" [-m <model>] [--output-format text|json|stream-json] [--permission read-only|workspace] [--allow <rule>] [--deny <rule>]`: headless run. Read-only unless `--permission workspace`. `--check <cmd>` declares a check for the done gate. `--goal <condition>` keeps the run going until a separate judge finds the condition holds (`--goal-judge <ref>`). `--sandbox auto|on|off` controls the OS sandbox for bash (Linux needs bubblewrap, socat, ripgrep). `--fallback <ref|none>` names the model a run continues on when its quota runs out (default `deepseek` → `anthropic/claude-haiku-5-5`); `--on-quota wait:<min>` waits up to that long for a quota that says when it resets before falling back. `--effort <level>` sets where the writer starts and `--escalate <level|off>` (default high) where it moves, once, when the done gate refuses a claim (Claude 5.5 models; a per-message effort change, so the cache stays). `--plan <ref>` and `--review <ref>` add the plan and review roles, `--advisor <ref>` a model that reads each writer turn and may leave a note (`claude-code[:<model>]` runs them in the user's own Claude Code); `roles` in `~/.cedia/settings.json` sets all three. `CEDIA_CLAUDE_BIN` points tests at a fake `claude`. Every run is a thread of the project: `--thread <id>` goes on with one, `--handoff-at <n|off>` sets when a long session hands off to a new one, `--handoff note|compact` how (compact: Anthropic's server compaction keeps the newest turns, Claude API models only), `--spawn on|off|worktree` and `--swarm <ref>` control sub-threads (worktree: each work sub-thread in a git worktree of its own, several at once). `--ask on` gives the writer `ask_user`, which ends the run with one question for the owner (thread state `asking`; the answer is the next prompt). `--todo on` gives it `todo`, a list of steps kept in the thread as its progress. `--profile <name>` lays a named set of defaults under the flags (`profiles` in settings; built in: `coordinator`, which opens queued threads with `open_thread`).
- `bin/cedia` with no prompt, at a terminal: the TUI (`src/clients/tui/main.ts`). Each prompt is a turn of one thread on the `-p` path; `/help` lists its commands. `test/tui.test.ts` drives it offline through a fake terminal.
- `bin/cedia threads [list [--all] | show <id> | send <id> <text> | unsend <id> [<msg>...] | rate <id> <up|down> | archive <id> | diff <id> | undo <id> | redo <id> | rewind <id> [<n>]]`: the project's threads. `undo` and `redo` move the files of the thread's last turn that changed files, from the shadow snapshots; `rewind` takes the thread back to just before run n, conversation and files together.
- `bin/cedia schedules [list | due | add <when> <prompt> --thread <id> [--every <dur>] | cancel|pause|resume|fire <id>] [--json]`: the project's scheduled prompts. cedia only says what is due; the desktop's daemon (or cron) fires and runs each one.
- `bin/cedia memory [list | add <text> | forget <id>]`: the project's memory, which every new session gets in its first turn.
- `bin/cedia skills`: the skills a session here can load (`~/.cedia/skills`, and the repository's `.agents/skills`, `.claude/skills`, `.cursor/skills`); the model loads one with the `skill` tool.
- MCP servers come from `mcpServers` in `~/.cedia/settings.json` only (`src/core/mcp/`); `test/mcp/server.ts` is a fake stdio server for tests.
- `bin/cedia --version --json`: version, protocol schema hash and capabilities, for clients.
- `bin/cedia usage [<file.jsonl>... | --thread <id> | --last <n>] [--json]`: where a project's spend went, from its session logs: input by source (counted each time a request resent it), the costliest tool results, cache misses by cause, requests past a long-context price line or at effort max, handoffs. A run's JSON result names its own misses in `cacheMisses`.
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
