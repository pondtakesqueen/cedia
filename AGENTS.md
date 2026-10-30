# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` points here.

## What this is

cedia is a personal coding harness written from scratch in TypeScript on Bun.

- `SPEC.md` holds every settled decision and the stage order. Read it before changing scope.
- `docs/ROADMAP.md` says what comes next.
- `docs/CLI.md` lists every command and flag. Read it when a task touches the CLI, a flag or a default.

## Commands

- `bun install --frozen-lockfile`: install, as CI does.
- `bun test`: all tests. One file: `bun test test/layers.test.ts`. One test: add `-t "<name>"`.
- `bun run typecheck`: `tsc --noEmit`.
- `bun run build:release`, then `./dist/cedia --version --json`: the release build that CI checks.
- `bin/cedia -p "<prompt>"`: a headless run, read-only unless `--permission workspace`. `bin/cedia` alone at a terminal: the TUI.
- `-m faux` with `CEDIA_FAUX_SCRIPT=<steps.json>`: a run with no network, for tests.
- `bun scripts/protocol-schema.ts` after a protocol type changes, and `bun scripts/session-fixtures.ts` after the output of a run changes. `test/fixtures.test.ts` fails when either is stale.
- `bun evals/gate.ts --estimate`, then `bun evals/gate.ts`: the regression gate. Run it before merging a change to a prompt, a default, the loop, a tool or the trust layer (`evals/gate/README.md`). It spends money: print the estimate first.

## How to work

Work the pstack poteto-mode way:

- **Name the data shapes before writing logic.**
- **Decide by experiment.** When a question can be measured (a prototype, a test, an eval, the session logs), measure it instead of asking. Ask only when it cannot be measured or the choice is the owner's.
- **For a bug, write the failing test first.**
- **Small commits**, each one a unit that can be checked. Each commit message carries Verify (the test or command that reruns the done-criteria) and Risk (low/medium/high per the code-review skill's tier paths, and whether a person still needs to see it).
- A person always reviews changes to `src/core/safety/`, `src/core/providers/`, the sandbox, `scripts/`, CI workflows or `src/cli.ts` (`CONTRIBUTING.md`, `.agents/skills/code-review/SKILL.md`).

## Rules that are easy to get wrong

- `src/core` and `src/protocol` never import from `src/clients`. `test/layers.test.ts` enforces it.
- Model-visible means logged: anything that reaches the model is an event in the session log first.
- Keep the cached prefix byte-identical (see "Cache rules" in `SPEC.md`). Never edit message 0 mid-session.
- Every `tool_use` gets a `tool_result`, including denied and not-started calls.
- API keys only. Never add Claude.ai OAuth, Cursor login, or any request that impersonates another client.
- Never copy code or prompts from `anthropics/claude-code` (no license) or leaked sources, and never port cedia-rs. Adapted Apache-2.0/MIT code needs a `NOTICE` entry.
- e2e tests use the faux provider and must work offline.

## Gotchas

- `bunfig.toml` sets the test root to `test/`. The stubs under `evals/tasks/` fail on purpose, so don't point `bun test` at them.
- Sandbox tests skip locally when there is no `bwrap` (Linux). CI sets `CEDIA_REQUIRE_SANDBOX=1`, so a missing sandbox fails there: a local pass does not cover those tests.
- Ink is patched through `patches/ink@8.0.0.patch` (`patchedDependencies` in `package.json`). Change the patch, not `node_modules/ink`.

## Research

- `research/NOTES.md`: distilled findings with source paths. `research/mirror-docs.sh` re-downloads official docs into `research/docs/` (gitignored). Grep there before searching the web.
