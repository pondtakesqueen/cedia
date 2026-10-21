# cedia spec

cedia is a personal coding harness written from scratch in TypeScript on Bun. It replaces Claude Code and Codex for one developer's daily work. The goal is a harness the user can trust and afford: every "done" is backed by evidence the harness recorded, and the prompt cache hit rate matches the DeepSeek harness. Progress is measured by an eval suite run against pi, Claude Code and Codex on the same tasks.

The full plan, with the comparison against other harnesses and the review it went through, is the "แผนสร้าง cedia v1" doc (rev 16, 2026-10-21). Research findings and source paths are in `research/NOTES.md`.

## Decisions

| Topic | Decision |
|---|---|
| Language, runtime | TypeScript on Bun |
| Shape | Own core, written here. Libraries as dependencies where they do not touch the core: pi-tui for the TUI, `@anthropic-ai/sandbox-runtime` for the sandbox. Not a fork: the pi-era cedia ran into pi core limits (paste expansion before hooks, provider layer) that needed a fork, and the core is where cedia differs. |
| Plan and thinking | Claude top-tier through an API key (Anthropic Messages) |
| Writing code | DeepSeek V4.1 Flash through OpenCode Go (ZDR), Haiku 5.5 as fallback; beam-free for volume work while it is free |
| Muse Spark | Only on repos marked public: the Contributor tier trains on prompts and completions |
| Wire formats | Anthropic Messages, Chat Completions, OpenAI Responses |
| Auth | API keys only. No Claude.ai or Cursor OAuth, no request that impersonates another client |
| Sandbox | `@anthropic-ai/sandbox-runtime`, stage 2 |
| Permission | Sandbox + deterministic argv read-only policy + allow rules (stage 2); classifier (stage 6) |
| Edit tool | `edits[]` with tiered matching; `apply_patch` for GPT; edit mode chosen per model from eval results |
| Compaction | Client side for every model: clear old tool results first, then summarize; grep-able segments |
| Session | Append-only JSONL tree; a `request` event before every model call so each request can be rebuilt from the log |
| Protocol | JSONL over stdio; ACP later |
| Cache | Target ≥ 90% hit ratio per session with every miss attributed; TTL 5 minutes, 1 hour optional after measuring cost |
| Spend | Warn when daily spend passes $20 |
| Old code | No code from cedia-rs (traces to claw_code). From the pi-era package keep `evals/` and use `trust.ts` logic as a reference |

## Architecture

Clients (TUI, headless `-p`, eval runner) talk to the core over one protocol. Inside the core every event is written to the session log first, and the context builder builds the next request from that log, so resume, fork, compaction and evals take the same path.

```
src/
  cli.ts
  core/        no UI; tested with a faux provider
    loop/ session/ context/ providers/ tools/ safety/ trust/ skills/ hooks.ts roles.ts
  protocol/    command and event types + JSONL codec
  clients/     tui/ headless/
evals/         tasks/, run.ts, baseline/
```

Rule enforced by a test: `src/core` and `src/protocol` never import from `src/clients`.

## Cache rules

Taken from the DeepSeek harness (`packages/core/agent-loop/README.md`, "KV Cache effect") and Claude Code's prompt caching docs.

1. The prefix stays byte-identical: tools in a fixed order, system prompt sections in a fixed order, no paths or per-process values in the cached part.
2. A system prompt change mid-session is appended as a system message, never written into message 0.
3. The tool list is frozen at the first request; later tools come through tool search or an appended announcement.
4. Cancelled tool calls get synthetic results appended; history is never cut.
5. Roles change only when a subagent starts. The main session never switches model; each subagent owns its cache.

Per provider: Anthropic uses automatic `cache_control` plus a breakpoint at the end of tools and system; OpenCode Go requests carry a stable `x-opencode-session` and cedia's own User-Agent; Responses requests carry `prompt_cache_key`. Each `request` event records model, effort, tools hash, system hash, TTL and headers, so a miss can be traced to what changed.

## Model roles

| Role | pstack roles it serves | Default |
|---|---|---|
| `plan` | judgment and prose, hardest tasks, how explainer, why synthesizer, reflect judgment | Claude top-tier, effort medium |
| `code` | feature/refactoring, bug-fix, perf-issue, hillclimb, how explorer, why investigators | DeepSeek V4.1 Flash, fallback Haiku 5.5 |
| `smol` | classifier, `/goal` judge, input repair, titles, commit messages | Haiku 5.5 |
| `swarm` | swarm workers, reflect tooling | beam-free, then DeepSeek V4.1 Flash |
| `panel` | arena, architect, interrogate, cross-judge | Claude + DeepSeek V4 Pro; Muse only on public repos |
| `advisor` | reviews the `code` role each turn (from oh-my-pi) | Claude, low effort, read-only |

## pstack

cedia runs the original pstack without editing its files. `cedia setup` clones it to `~/.cedia/plugins/pstack`. cedia supplies what Cursor supplied: `Task`, `AskQuestion`, todo lists, per-role models from `~/.cedia/rules/pstack-models.md`, and `docs/harness/cedia.md` mapping Cursor names to cedia's. Cursor-only features are skipped with a "Skipped in cedia" line.

## Stages

Each stage ends with something usable, and every done-criterion has a test or a repeatable command. The full checklists are in the plan doc.

0. Clean the repo: move evals and the baseline in, delete the pi package, Bun skeleton, CI.
1. Core: three wire formats, faux provider, `request` and `attempt` events, minimal read and bash, ≥ 90% cache hit on a 20-turn session on Claude and DeepSeek.
2. Tools, permission, session, sandbox, evidence ledger and claim check, hooks, first eval baseline.
3. TUI on pi-tui, minimal compaction, one full day of real use.
4. AGENTS.md, full compaction, memory, light `/goal`, cache warming.
5. Skills, MCP, subagents by role, advisor, web.
6. Rewind, LSP, delegate, full goal mode, classifier, full eval against pi, `claude -p` and `codex exec`.

## Eval

- Run each task 3 times in a clean temp dir; report pass@1, pass^3, false-done rate, time, tokens and cost.
- The task's check decides, never the agent's words; read the transcript whenever a result changes.
- Every prompt or default change runs the eval before merge.
- The pi-era set (8 tasks, all harnesses 8/8) is a regression floor. New tasks come from cedia's own git history and must separate harnesses.

## Licenses

Keep `NOTICE` for adapted Apache-2.0 or MIT code. Never copy from `anthropics/claude-code` (no license) or leaked sources, and never port cedia-rs code.
