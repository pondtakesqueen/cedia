# Contributing to cedia

This repository is proprietary (see `LICENSE`): talk to the owner before writing code. The notes below are the working agreement for anyone who does.

## The pstack poteto-mode way

- Name the data shapes before writing logic.
- Prove it works: every done-criterion has a test or a command that reruns.
- Decide by experiment (prototype or eval) instead of asking when the question can be measured.
- Small commits, each one a unit that can be checked. Commit messages carry Verify (the test or command) and Risk (low/medium/high, and whether a person still needs to see it).

## Before you merge

- `bun run typecheck` and `bun test` green.
- A change to a prompt, a default, the loop, a tool, or the trust layer runs the eval gate first (`bun evals/gate.ts`; `evals/gate/README.md`) and puts its report in the PR description. A change meant to move the numbers runs `--update-baseline` in the same PR and says why.
- Protocol types changed? Regenerate with `bun scripts/protocol-schema.ts`. Run output changed? Re-record with `bun scripts/session-fixtures.ts` (`test/fixtures.test.ts` fails when either is stale).

## Clean room

- Never copy code or prompts from unlicensed or leaked sources, and never port cedia-rs. Adapted Apache-2.0/MIT code needs a `NOTICE` entry.
- `src/core` and `src/protocol` never import from `src/clients` (`test/layers.test.ts` enforces it).
- API keys only. Never add logins or requests that impersonate another client.
- e2e tests use the faux provider and must work offline.

## Review

Review the diff, not the codebase around it. Sort strictly (Important blocks, Nits never do, Pre-existing gets one line), verify important findings with a reproduction, and end with exactly one verdict line (`VERDICT: approve` or `VERDICT: changes`). Changes touching `src/core/safety/`, `src/core/providers/`, the sandbox, `scripts/`, CI workflows, or `src/cli.ts` always get a human look. See `.agents/skills/code-review/SKILL.md`.
