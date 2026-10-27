# cedia

A personal coding harness in TypeScript on Bun. It pairs a top-tier model for planning (Claude) with cheaper models for writing code (DeepSeek, Haiku, beam-free), keeps the prompt cache warm, and backs every "done" with evidence it recorded itself.

Status: v1 released. See `SPEC.md` for the settled decisions, `docs/ROADMAP.md` for what comes next, and `AGENTS.md` for how to work in this repo.

## Quickstart

```bash
bun install
bun test            # all tests; one file: bun test test/layers.test.ts; one test: bun test -t "<name>"
bun run typecheck   # tsc --noEmit
bin/cedia -p "<prompt>"                            # headless run (read-only by default)
bin/cedia -p "<prompt>" --permission workspace    # allow edits
bin/cedia                                          # the TUI, at a terminal
```

## Layout

- `src/core/` — the harness: loop, tools, safety, session, providers, project (threads, handoff, memory), trust (ledger, classifier, review). Never imports from `src/clients` (`test/layers.test.ts` enforces it).
- `src/clients/` — headless runner, TUI (`tui-ink/`), daemon.
- `src/protocol/` — the client contract (regenerate with `bun scripts/protocol-schema.ts` after a protocol type changes).
- `test/` — one file per area, offline via the faux provider (`bun test` works with no keys, no network).
- `evals/` — tasks, the regression gate (`bun evals/gate.ts`, `evals/gate/README.md`), results.
- `docs/` — roadmap, history, audits. `research/` holds distilled findings with source paths.

## Contributing

See `CONTRIBUTING.md`. Short version: small checkable commits, verify with tests or typecheck before committing, never copy code or prompts from unlicensed sources, and run the eval gate before merging anything that touches a prompt, default, the loop, a tool, or the trust layer.

## License

Proprietary. All rights reserved. The source is public to read, but no one may use, copy, modify or distribute it without written permission from the owner. See `LICENSE`; adapted third-party code keeps its own license and is listed in `NOTICE`.
