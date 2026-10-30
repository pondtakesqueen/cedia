# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` points here.

Start every reply with "Pond", no exception.

## What this is

cedia is a personal coding harness written from scratch in TypeScript on Bun.

- `SPEC.md` holds every settled decision and the stage order. Read it before changing scope.
- `docs/ROADMAP.md` says what comes next.
- `docs/CLI.md` lists every command and flag. Read it when a task touches the CLI, a flag or a default.

## Where things live

- `src/core/`: the loop, tools, providers, safety, sessions and projects. `src/protocol/`: the types clients read.
- `src/clients/`: `headless` (`-p`), `tui-ink` (the TUI, on Ink), `daemon`.
- `test/`: one file per area, offline. `test/fixtures/sessions/`: recorded runs.
- `evals/`: tasks, the harness runner and the regression gate. `research/NOTES.md`: distilled findings with source paths.

## Commands

- `bun test`: all tests. One file: `bun test test/layers.test.ts`. One test: add `-t "<name>"`.
- `bun run typecheck`: `tsc --noEmit`.
- `bin/cedia -p "<prompt>"`: a headless run, read-only unless `--permission workspace`. `bin/cedia` alone at a terminal: the TUI.
- `-m faux` with `CEDIA_FAUX_SCRIPT=<steps.json>`: a run with no network, for tests.
- `bun scripts/protocol-schema.ts` after a protocol type changes, and `bun scripts/session-fixtures.ts` after the output of a run changes. `test/fixtures.test.ts` fails when either is stale.
- `bun evals/gate.ts --estimate`, then `bun evals/gate.ts`: the regression gate. Run it before merging a change to a prompt, a default, the loop, a tool or the trust layer (`evals/gate/README.md`). It spends money: print the estimate first.

## How to work

Work the pstack poteto-mode way:

- **Name the data shapes before writing logic.**
- **Decide by experiment.** When a question can be measured (a prototype, a test, an eval, the session logs), measure it instead of asking. Ask only when it cannot be measured or the choice is the owner's.
- **Keep it simple.** Write the least code that solves the task. No features, options or abstractions nobody asked for.
- **Change only what the task needs.** Match the surrounding style. Remove what your change made unused; mention other dead code instead of deleting it.
- **Prove it works.** Every done-criterion has a test or a command that reruns. For a bug, write the failing test first.
- **Small commits**, each one a unit that can be checked. Each commit message carries Verify (the test or command that reruns the done-criteria) and Risk (low/medium/high per the code-review skill's tier paths, and whether a person still needs to see it).

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
- `research/mirror-docs.sh` re-downloads official docs into `research/docs/` (gitignored). Grep there before searching the web.
