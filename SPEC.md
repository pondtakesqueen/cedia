# cedia spec

cedia is a personal coding harness written from scratch in TypeScript on Bun. It replaces Claude Code and Codex for one developer's daily work. The goal is a harness the user can trust and afford: every "done" is backed by evidence the harness recorded, and the prompt cache hit rate matches the DeepSeek harness. Progress is measured by an eval suite run against pi, Claude Code and Codex on the same tasks.

The full plan, with the comparison against other harnesses and the review it went through, is the "แผนสร้าง cedia v1" doc (rev 17, 2026-10-21). Research findings and source paths are in `research/NOTES.md`.

## Decisions

| Topic | Decision |
|---|---|
| Language, runtime | TypeScript on Bun |
| Shape | Own core, written here. Libraries as dependencies where they do not touch the core: pi-tui for the TUI, `@anthropic-ai/sandbox-runtime` for the sandbox. Not a fork: the pi-era cedia ran into pi core limits (paste expansion before hooks, provider layer) that needed a fork, and the core is where cedia differs. |
| Plan and thinking | Claude top-tier through an API key (Anthropic Messages) |
| Writing code | DeepSeek V4.1 Flash through OpenCode Go (ZDR), Haiku 5.5 as fallback; beam-free for volume work while it is free |
| Muse Spark | Only on repos marked public: the Contributor tier trains on prompts and completions |
| Wire formats | Anthropic Messages, Chat Completions, OpenAI Responses |
| Auth | API keys only, from the environment (`CEDIA_ANTHROPIC_API_KEY` stands in for `ANTHROPIC_API_KEY`, which Claude Code cloud sessions drop) or added by an egress proxy (cloud network secrets). No Claude.ai or Cursor OAuth, no request that impersonates another client |
| Sandbox | `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, sandbox-exec on macOS) around every bash call: writes only in the working directory and temp dir, no reads of the credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.docker/config.json`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.kube/config`, cedia's home), network only to package registries plus `--allow-domain`/user settings. `--sandbox auto` (default) falls back to unsandboxed with a stderr note; `on` requires it. Bash never inherits keys, tokens or `CEDIA_*` env. Edit and write never touch `.git/` or `.cedia/` |
| Permission | cedia never stops to ask: a denied call returns its reason to the model and the run goes on, so it can be left alone. Modes `auto` (default: `workspace` when the sandbox is on, `read-only` when it is off), `read-only` and `workspace`; allow/deny rules; built-in guards; then the sandbox (stage 2); classifier (stage 6). Rules: flags > `CEDIA_PERMISSION` > `~/.cedia/settings.json`; a repo's `.cedia/settings.json` can only add deny rules |
| Guards | The deny list plus `secret-path` (credential stores, for every tool) and `secret-redaction`. Only the user lifts one, by name: `--unlock <guard>` or `permissions.unlock` in `~/.cedia/settings.json`. Never a repo, an allow rule or the model. cedia's prompt adds no content rules of its own. `context` in `~/.cedia/settings.json` (a string or lines) is the user's standing context, sent in the first user turn of every session as `<user_context>`; a repo cannot set it |
| Privacy | No telemetry: cedia talks only to the model provider. Secrets in tool output (known token formats, private keys, dotenv/JSON/URL passwords) are replaced with `[cedia:redacted]` before the result is logged or sent, and a write carrying the placeholder is denied. `--privacy no-training` (default) refuses `dataPolicy: trains` models outside public repos; `zdr` allows only zero-data-retention models. flags > `CEDIA_PRIVACY` > user settings; a repo may set `zdr` but never loosen it |
| Edit tool | `edits[]` with tiered matching; `apply_patch` for GPT; edit mode chosen per model from eval results |
| Compaction | Claude: server-side context editing and on-demand compaction (`compact-2026-09-04`), or a client-side summary of the whole history with thinking stripped; never client-side tool-result clearing or keep-tail, because Claude 5.5-family thinking signatures bind the unedited prefix. Chat Completions and Responses: client side, clear old tool results first, then summarize. Segments stay grep-able |
| Session | Append-only JSONL tree; a `request` event before every model call so each request can be rebuilt from the log. Header values are never logged: names plus value hashes only |
| Protocol | JSONL over stdio; ACP later |
| Cache | Target ≥ 90% hit ratio per session with every miss attributed; TTL 5 minutes, 1 hour optional after measuring cost |
| Spend | Warn when daily spend passes $20 |
| Config precedence | flags > env > project `.cedia/` > user `~/.cedia/` > defaults; arrays union and dedupe |
| Public repo marker | A `.cedia/public` file in the repo. Without it, models with `dataPolicy: trains` are refused |
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

Session files live at `~/.cedia/sessions/<project-slug>/<id>.jsonl`. The first line is a `session` event `{cwd, parentSession?, role, createdAt}`. The leaf is the last event; a fork is a new file whose first event's `parentId` points into the source.

## Core shapes

These are fixed before stage 1 code is written. Names may change; the information each one carries may not shrink.

```ts
// Assistant content keeps each wire's opaque reasoning payload so it can be replayed byte for byte.
type AssistantBlock =
  | { type: 'text'; text: string; sig?: string }
  | { type: 'thinking'; text: string; opaque?: string; redacted?: boolean }
  | { type: 'tool_use'; id: string; callId?: string; name: string; input: JsonObject; inputError?: string };
// The assistant event records which wire produced it; blocks are only replayed to the same wire.
type AssistantEvent = { kind: 'assistant'; wire: Wire; model: string; blocks: AssistantBlock[]; stop: StopReason; usage: Usage };
type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'aborted' | 'error';

// Provider boundary. One adapter per wire; the loop never sees wire JSON.
type Provider = { wire: Wire; stream(req: WireRequest, signal: AbortSignal): AsyncIterable<StreamEvent> };
type StreamEvent =
  | { type: 'start' }
  | { type: 'text_start' | 'text_end'; index: number } | { type: 'text_delta'; index: number; delta: string }
  | { type: 'thinking_start' | 'thinking_end'; index: number } | { type: 'thinking_delta'; index: number; delta: string }
  | { type: 'toolcall_start'; index: number; id: string; name: string } | { type: 'toolcall_delta'; index: number; delta: string } | { type: 'toolcall_end'; index: number }
  | { type: 'done'; message: AssistantEvent }
  | { type: 'error'; error: AttemptError };

// Every turn ends with one turn_end event, including aborts.
type TurnEnd = { kind: 'turn_end'; reason: 'completed' | 'aborted' | 'error' | 'max_tokens' | 'budget' | 'max_turns'; cause?: 'user' | 'parent' | 'hook' };

type AttemptError = {
  code: 'rate_limit' | 'overloaded' | 'auth' | 'bad_request' | 'network' | 'timeout' | 'server' | 'context_length';
  status?: number; retryAfterMs?: number; message: string;
};

// Headless result. Exit code 0 only on 'success'.
type HeadlessResult = {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | 'interrupted' | 'error_unverified_claim';
  sessionId: string; numTurns: number; usage: Usage; costUsd: number; cacheHitRatio: number; result: string; evidence?: Evidence;
};

// Per-model facts the adapters and the loop branch on.
type ModelCapabilities = {
  reasoning: 'anthropic-thinking' | 'reasoning_content' | 'responses-item' | 'none';
  replayReasoning: 'required' | 'forbidden' | 'same-turn';
  parallelToolCalls: boolean; input: ('text' | 'image')[]; effortLevels: string[];
  cacheMinTokens: number; midConversationSystem: boolean; contextWindow: number;
};

type ToolOutput = { text: string; images?: BlobRef[] };
```

Rules that go with the shapes:

- **Abort.** `signal` aborts the stream; the adapter emits `done` with `stop: 'aborted'` and whatever blocks were complete. Unfinished tool calls get synthetic `tool_result`s. The turn ends with `turn_end{reason:'aborted'}`.
- **Retry.** `rate_limit`, `overloaded`, `network`, `timeout` and `server` retry with exponential backoff, at most 5 attempts, honouring `retryAfterMs`. `auth`, `bad_request` and `context_length` never retry. Each try is its own `attempt` event.
- **Request event.** Carries model, effort, `toolsHash`, `systemHash`, `bodyHash`, TTL and header names with value hashes. Never header values.
- **Role fallback** starts a new session on the fallback model; it never swaps the model inside a session (cache rule 5).
- **Mid-conversation system prompt.** Appended as a system message when `midConversationSystem` is true, otherwise as a user text block.
- **Parallel tools.** Calls whose `ToolSpec.effect` is `read` or `network` run in a bounded pool; `write_workspace` and `exec` run alone, as ordering barriers. `tool_intent` events are written in assistant block order; results go back as one batch (Anthropic requires all results of a turn in one user message).
- **Permission order in the log.** `assistant → permission → tool_intent (only if allowed) → tool_result`. A denied call gets `tool_result{status:'denied'}` and no `tool_intent`.
- **Token estimate.** The last response's `usage` plus `chars/4` for the delta; Anthropic `count_tokens` on demand.
- **Faux provider.** A script is an array of assistant messages or factories `(context, state) => AssistantEvent`, emitted as delta-level `StreamEvent`s. It computes `usage` by hashing the prefix it was sent, so `cacheRead` is nonzero exactly when the prefix repeats. Shape modeled on pi's faux provider (MIT); add a NOTICE entry if code is adapted.

Protocol events (core → client): every session event, plus `stream` (the `StreamEvent`s of the current attempt), `turn_end` and `result`. Commands (client → core): `prompt`, `abort`, `permission_reply`, `resume`, `fork`.

## Cache rules

Taken from the DeepSeek harness (`packages/core/agent-loop/README.md`, "KV Cache effect") and Claude Code's prompt caching docs.

1. The prefix stays byte-identical: tools in a fixed order, system prompt sections in a fixed order, no paths or per-process values in the cached part.
2. A system prompt change mid-session is appended as a system message, never written into message 0.
3. The tool list is frozen at the first request; later tools come through tool search or an appended announcement.
4. Cancelled tool calls get synthetic results appended; history is never cut.
5. Roles change only when a subagent starts. The main session never switches model; each subagent owns its cache.

Per provider: Anthropic uses automatic `cache_control` plus a breakpoint at the end of tools and system; OpenCode Go requests carry a stable `x-opencode-session` and cedia's own User-Agent; Responses requests carry `prompt_cache_key`. Each `request` event records model, effort, tools hash, system hash, body hash, TTL and header names, so a miss can be traced to what changed.

`Usage` keeps disjoint `uncached / cacheRead / cacheWrite / output` fields. Mapping per wire:

| Wire | cacheRead | cacheWrite | uncached |
|---|---|---|---|
| Anthropic Messages | `cache_read_input_tokens` | `cache_creation_input_tokens` | `input_tokens` |
| Chat Completions | `prompt_tokens_details.cached_tokens`, or DeepSeek `prompt_cache_hit_tokens` | 0 | `prompt_tokens` minus cacheRead |
| Responses | `input_tokens_details.cached_tokens` | 0 | `input_tokens` minus cacheRead |

Reasoning tokens are a subset of `output`. Hit ratio = cacheRead / (uncached + cacheRead + cacheWrite).

Providers cache in blocks (`cacheBlockTokens`): DeepSeek in 128-token blocks, and Anthropic reads stop a few tokens short at the turn boundary. A read is a miss only when it falls more than one block short of the previous input. Measured numbers live in `evals/cache/`.

Claude 5.5-family models also bind thinking signatures to the prefix, so any history edit is a correctness bug, not just a cache miss. Stage 4 checks this three ways: diff captured requests turn to turn; run with `prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`) and log any `input_transformations`; then set the field explicitly.

## Model roles

| Role | pstack roles it serves | Default |
|---|---|---|
| `plan` | judgment and prose, hardest tasks, how explainer, why synthesizer, reflect judgment | Claude top-tier, effort medium |
| `code` | feature/refactoring, bug-fix, perf-issue, hillclimb, how explorer, why investigators | DeepSeek V4.1 Flash, fallback Haiku 5.5 |
| `smol` | classifier, `/goal` judge, input repair, titles, commit messages | Haiku 5.5 |
| `swarm` | swarm workers, reflect tooling | beam-free, then DeepSeek V4.1 Flash |
| `panel` | arena, architect, interrogate, cross-judge | Claude + DeepSeek V4 Pro; Muse only on public repos |
| `advisor` | reviews the `code` role each turn (from oh-my-pi) | Claude, low effort, read-only |

## Trust

Guarantees that hold whatever model runs come from the log, not the model's words.

- **Done gate** (`core/trust/ledger.ts`, stage 2). When the agent claims done and the ledger has no passing declared check after its last write, cedia appends one reminder naming the checks and lets the model continue; a second unverified claim ends the run with `error_unverified_claim` and exit code 1. Only declared checks count (`--check`, or `checks` in `~/.cedia/settings.json` or the repo's `.cedia/settings.json`), and only when the bash command is exactly the check: a pipe would hide its exit code. Writes are completed `edit`/`write` calls and any bash command that is not read-only. With no declared checks the gate is off and the receipt lists everything as unverified.
- **Receipt.** Every turn that changed files ends with a receipt from the ledger: files changed, checks run, their results.
- **Deny list** (`core/safety/policy.ts`, stage 2, before the stage-6 classifier): force-push (including `--force-with-lease`, `+refspec`, branch deletion), `git reset --hard` and `git clean -f` (any branch until shadow snapshots can undo them), `rm -r` or `find -delete` outside the workspace or on targets that cannot be resolved, and publish/deploy commands (`npm publish`, `vercel --prod`, `kubectl apply`, `terraform apply`, `gh pr merge` and similar). It reads each simple command, through `sudo`, `nice -n`, `timeout`, `xargs`, `bash -c`, `$( )` and chains. No mode or allow rule lifts it; the user can unlock one guard by name. pstack's "Always pause" list is a harness rule because a weak model will not pause on its own. It guards against mistakes; the sandbox is the boundary.
- **Untrusted content.** Tool results (files, command output, web pages) are data: the base prompt says so, and they only ever reach the model inside `tool_result` blocks. `evals/tasks/hard-injection` plants instructions in a README and a code comment and fails any run that follows them. A small-model injection screen on tool output is a stage-6 candidate. A guard's denial tells the model not to work around it; a command the shell reader cannot parse (`shell:unparsed`) tells it to rewrite instead.
- **Permission event.** Every call that reaches the policy logs `permission{decision, rule, reason}`; a denied call gets `tool_result{status:'denied'}` naming the rule, and no `tool_intent`.
- **Read-only** subagents get write tools and MCP stripped by `ToolSpec.effect`, not by prompt.
- **Session linter** (`cedia lint-session <file>...`, `core/session/lint.ts`, stage 2): session event first and an unbroken parent chain; every `tool_use` gets exactly one `tool_result` before the next request; `permission → tool_intent → tool_result` order, and denied calls never run; `systemHash`/`toolsHash` constant (until a `tools_changed` event exists); header values are hashes; every `request` has numbered `attempt`s before its `assistant`; the log ends with `turn_end`. The loop and e2e tests lint every faux session they produce.

## Git

cedia is not a git client; it covers what an agent session needs and leaves the rest to `git`, `gh` or lazygit through `!`.

| Feature | Stage | Notes |
|---|---|---|
| Deny list for force-push and `git reset --hard` on shared branches | 2 | Trust section |
| Shadow-git snapshot around each writing call | 2 | `~/.cedia/snapshots/<project-slug>`, own index, user/system git config ignored; never touches the user's repo or index. A `snapshot{tree, callId, changed}` event names the files each call changed, bash included, which Claude Code's checkpoints do not; the ledger and receipt use it |
| Branch and dirty count in the status line | 3 | |
| `/diff`: working tree changes, and changes since the turn started | 3 | Like Codex and OpenCode `/diff` |
| `/undo` and `/redo` of the last turn's files | 3 | From the shadow snapshot; says plainly it does not undo external side effects |
| `/commit`: message from the `smol` role, user confirms | 4 | Stages only files the session changed unless told otherwise |
| `/pr`: push the branch and open a PR through `gh` | 4 | Push needs approval; never to the default branch |
| `/review`: review the diff or a PR with the `panel` role | 5 | Findings come with evidence |
| Worktree per subagent | 5 | |
| `/rewind` conversation and files together | 6 | |

## pstack

cedia runs the original pstack without editing its files. `cedia setup` clones it to `~/.cedia/plugins/pstack`. cedia supplies what Cursor supplied: `Task`, `AskQuestion`, todo lists, per-role models from `~/.cedia/rules/pstack-models.md`, and `docs/harness/cedia.md` mapping Cursor names to cedia's. Cursor-only features are skipped with a "Skipped in cedia" line.

## Stages

Each stage ends with something usable, and every done-criterion has a test or a repeatable command. The full checklists are in the plan doc.

0. Clean the repo: move evals and the baseline in, delete the pi package, Bun skeleton, CI.
1. Core: the shapes above, three wire formats, faux provider, `request` and `attempt` events, abort and retry, headless result, minimal read and bash. Gate: an offline faux test where `systemHash` and `toolsHash` stay constant and each prefix extends the last across 20 tool-using turns. Measured, not gated: `bun scripts/cache-probe.ts --model <ref> --turns 20 --runs 3` on Claude and DeepSeek, reporting hit ratio, spread and every miss with its cause (target ≥ 90%).
2. Tools, permission and deny list, session, sandbox (CI installs bubblewrap), evidence ledger, done gate, session linter, hooks, `evals/run.ts` with 3 runs, tokens and cost, first single-model eval baseline (`evals/results/`). The four-arm comparison needs a planner handing work to a writer, so it runs once subagents exist (stage 5).
3. TUI on pi-tui, minimal compaction, one full day of real use.
4. AGENTS.md, full compaction (per-wire rule above, with the three-step thinking check), memory, light `/goal`, cache warming.
5. Skills, MCP, subagents by role, advisor, web; first four-arm comparison.
6. Rewind, LSP, delegate, full goal mode, classifier, full eval against pi, `claude -p` and `codex exec`, and the four-arm comparison again.

## Eval

- Run each task 3 times in a clean temp dir; report pass@1, pass^3, false-done rate, time, tokens and cost.
- The task's check decides, never the agent's words; read the transcript whenever a result changes.
- Every prompt or default change runs the eval before merge.
- The pi-era set (8 tasks, all harnesses 8/8) is a regression floor. New tasks come from cedia's own git history and must separate harnesses.
- **Budget order.** Run every eval on Haiku 5.5 and the OpenCode Go models first; Opus arms run last, once the cheap arms have settled the task set. Each paid run prints its estimated cost first.
- **Four-arm comparison** decides whether the cheap-writer pairing earns its place: (a) `claude -p` with Opus, (b) cedia Opus plans + DeepSeek writes, (c) cedia Opus + Opus, (d) cedia Opus + Haiku. 3 runs each; pass^3, false-done rate and cost per passed task. (c) against (a) measures the harness; (b) and (d) against (c) measure the pairing. A pairing becomes the default for a task category only if it is within 3 points of (a) on pass^3 and at least 2x cheaper per passed task.

## Licenses

Keep `NOTICE` for adapted Apache-2.0 or MIT code. Never copy from `anthropics/claude-code` (no license) or leaked sources, and never port cedia-rs code.
