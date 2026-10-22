# cedia spec

cedia is a personal coding harness written from scratch in TypeScript on Bun. It replaces Claude Code and Codex for one developer's daily work. The goal is a harness the user can trust and afford: every "done" is backed by evidence the harness recorded, and the prompt cache hit rate matches the DeepSeek harness. Progress is measured by an eval suite run against pi, Claude Code and Codex on the same tasks.

The full plan, with the comparison against other harnesses and the review it went through, is the "แผนสร้าง cedia v1" doc (rev 17, 2026-10-21). Research findings and source paths are in `research/NOTES.md`.

## Decisions

| Topic | Decision |
|---|---|
| Language, runtime | TypeScript on Bun |
| Shape | Own core, written here. Libraries as dependencies where they do not touch the core: pi-tui for the TUI, `@anthropic-ai/sandbox-runtime` for the sandbox. Not a fork: the pi-era cedia ran into pi core limits (paste expansion before hooks, provider layer) that needed a fork, and the core is where cedia differs. |
| Plan and thinking | Claude top-tier through an API key (Anthropic Messages) |
| Writing code | DeepSeek V4.1 Flash through OpenCode Go (ZDR); beam-free for volume work while it is free. When the Go quota runs out, Haiku 5.5 on the Claude API picks the task up in a new session: off the Go plan, not trained on, and as good on the hard evals for less. DeepSeek's own API (`deepseek-api`) counts as `trains`, so under `no-training` it runs only in public repos |
| Muse Spark | Only on repos marked public: the Contributor tier trains on prompts and completions |
| Wire formats | Anthropic Messages, Chat Completions, OpenAI Responses |
| Auth | API keys only, from the environment (`CEDIA_ANTHROPIC_API_KEY` stands in for `ANTHROPIC_API_KEY`, which Claude Code cloud sessions drop), then on macOS from the Keychain (a generic password with service `cedia` and the variable's name as account, so the CLI and the desktop share one store; `CEDIA_KEYCHAIN=off` skips it), or added by an egress proxy (cloud network secrets). The secret-path guard denies bash calls that read the Keychain (`security find-generic-password` and the like). No Claude.ai or Cursor OAuth, no request that impersonates another client. A Claude subscription is used only by running the user's own Claude Code CLI as the plan or review step (`claude-code[:<model>]`); cedia never reads or sends its credentials, and strips API keys from its environment so it bills the subscription |
| Roles | One run is plan > code > review > one fix round. `--plan`, `-m` (code) and `--review`, or `roles` in `~/.cedia/settings.json` (a repo cannot set them); each is a catalog model or, for plan and review, `claude-code[:<model>]` (opus and sonnet by default), or `none`. The code role always runs in cedia, where writes meet the policy, sandbox and done gate. Plan and review are read-only: in cedia, read and bash under a read-only policy plus the declared checks; in Claude Code, `--tools` and `--permission-mode dontAsk` with only Read, Grep, Glob, read-only git and the checks allowed. Under `zdr` a step does not go to Claude Code. A Claude Code step's session and notional cost stay in Claude Code; consumer plans may train on it unless "Help improve Claude" is off |
| Sandbox | `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, sandbox-exec on macOS) around every bash call: writes only in the working directory and temp dir, no reads of the credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.docker/config.json`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.kube/config`, cedia's home), network only to package registries plus `--allow-domain`/user settings. `--sandbox auto` (default) falls back to unsandboxed with a stderr note; `on` requires it. Bash never inherits keys, tokens or `CEDIA_*` env. Edit and write never touch `.git/` or `.cedia/` |
| Permission | cedia never stops to ask: a denied call returns its reason to the model and the run goes on, so it can be left alone. Modes `auto` (default: `workspace` when the sandbox is on, `read-only` when it is off), `read-only` and `workspace`; allow/deny rules; built-in guards; then the sandbox (stage 2); classifier (stage 6). Rules: flags > `CEDIA_PERMISSION` > `~/.cedia/settings.json`; a repo's `.cedia/settings.json` can only add deny rules |
| Guards | The deny list plus `secret-path` (credential stores, for every tool) and `secret-redaction`. Only the user lifts one, by name: `--unlock <guard>` or `permissions.unlock` in `~/.cedia/settings.json`. Never a repo, an allow rule or the model. cedia's prompt adds no content rules of its own. `context` in `~/.cedia/settings.json` (a string or lines) is the user's standing context, sent in the first user turn of every session as `<user_context>`; a repo cannot set it |
| Privacy | No telemetry: cedia talks only to the model provider. Secrets in tool output (known token formats, private keys, dotenv/JSON/URL passwords) are replaced with `[cedia:redacted]` before the result is logged or sent, and a write carrying the placeholder is denied. `--privacy no-training` (default) refuses `dataPolicy: trains` models outside public repos; `zdr` allows only zero-data-retention models. flags > `CEDIA_PRIVACY` > user settings; a repo may set `zdr` but never loosen it |
| Edit tool | `edits[]` with tiered matching; `apply_patch` for GPT; edit mode chosen per model from eval results |
| Projects and threads | A project is a working directory, and every git worktree of a repository is the main worktree's project (`projectRoot` via `git rev-parse --git-common-dir`), so threads in different worktrees list, message and recall one another; the session event's `cwd` names the worktree, and snapshots stay per worktree. Every headless run is a thread of it (`~/.cedia/projects/<slug>/threads/<id>.jsonl`, append-only, so two cedia processes can write one without locks). `--thread <id>` goes on with a thread: in its last session when the model is the same, otherwise in a new session that starts from its latest handoff note or result. `cedia threads [list|show|send|archive]`. Modeled on Claude Projects' threads (each starts from the project's files, instructions and memory; threads run in parallel and can be resolved), built from the public docs and from using it, nothing reverse-engineered |
| Project instructions | The repository's AGENTS.md (or CLAUDE.md where a directory has none) in each directory from the repository's root down to the working directory, root first, with `@path` lines brought in (`core/project/instructions.ts`). They go in the first user turn after the environment, never the system prompt, framed as `<project_instructions path>` and made inert, 40k characters at most. They are the repository's words: an import may only name a file inside the repository (a symlink out counts as outside), and the permission mode, sandbox and deny list decide whatever they say |
| Memory | Project memory: short facts that outlive a thread, in `~/.cedia/projects/<slug>/memory.jsonl` (append-only; forgetting is an event). The user keeps them with `cedia memory add|forget`, the writer with the `remember` tool (at most 500 characters a note; denied in read-only sessions, absent in plan, review and sub-thread sessions). Every new session gets them in its first turn after the project instructions, newest first past 8k characters, made inert, with a line saying a note may be out of date. A session reads them once at its start, so a note written mid-session never touches a cached prefix |
| Handoff | Instead of compacting, a writer session whose context passes `handoffAt` (flag `--handoff-at`, `handoffAt` in user settings; default half the window, at most 150k, and below any long-context price) has doubled since its first reply, and, if it picked up from another session, has changed a file itself (a note cannot carry what was read, so a chain of sessions that only read would each read it all again; a first session may hand off before its first change, since on Haiku it otherwise read on past the 100k price line and handed off after its first edit anyway) is asked for a handoff note at the next turn boundary, while its prefix is still cached. The note carries the plan for what is left, concrete enough to follow, and the new session is told to carry it out rather than plan again: in the repo evals each successor re-read the code and spent 30k to 40k thinking tokens (about 2.5 minutes on Haiku) re-planning, which filled its context again after one file. A new session of the thread starts from the task and that note; it has `parentSession`, inherits the changed files for the done gate, and gets a `recall` tool that searches the earlier sessions' full logs. Nothing is edited, so thinking signatures and caches stay valid, and nothing is lost. At most 8 per run. `--handoff compact` (`handoff` in user settings) hands off by Anthropic's on-demand compaction instead, on the Claude API models (OpenCode Go drops its beta header): past 85% of the handoff point the provider summarizes the session up to an earlier request in the background, keeping at least the newest quarter of the context, while the session goes on; at the next turn boundary after the summary arrives (waiting for it at the handoff point) the session ends, and the next one starts from the signed summary block followed by copies of every event after the summarized request, thinking included (`core/project/compact.ts`). The kept turns' thinking stays valid because the provider wrote the summary on the same model, system prompt and tools, and they directly follow the messages it summarized. Such a session starts large by design (the kept turns and those that ran while the summary was written), so it hands off once it has grown by the kept share rather than doubled. A compaction that brings no summary hands back to the note |
| Sub-threads | The writer's `spawn{task, kind}` tool hands self-contained work to a child session with a fresh context; only its report (at most 4k characters) comes back. The model names the kind and cedia decides how it runs: `explore` is read-only on the `swarm` model (the code model under `zdr`) and runs in parallel, at most 4 at a time; `work` may write, on the writer's model under the run's policy, sandbox and checks, alone and between two snapshots, so the parent's ledger records its changes. A run starts at most 16 sub-threads. A child is its own thread with a `parent`, archives itself when it succeeds, stays listed when it fails, and cannot spawn. A `work` child hands off at the run's handoff point like the writer, to a new session of its own thread that gets `recall` over the child's earlier sessions (on Haiku a child past 100k would pay the long-context price every turn); `explore` never hands off, since a session that only read has nothing a note could carry. A writer that has not spawned is reminded of the tool once, when its context passes a third of its handoff point (in the repo evals Haiku never spawned unprompted, even at 170k). A sub-thread's spend counts against the run's `--max-budget-usd` as it happens, and the run's result counts sub-threads by kind, the handoffs their sessions made and the largest context one saw (`spawned`; `peakContext` is the run's own sessions'). `--spawn on|off`, `--swarm <ref>` |
| Thread messages | `threads`, `read_thread` and `message_thread` tools (present when the project has another thread): a message is appended to the other thread's file and shown to it as a logged reminder at its next turn boundary, or when it is resumed. `message_thread` is `write_workspace`, so read-only sessions cannot send. The user sends with `cedia threads send`, which prints the message id, and takes back one no session has seen yet with `cedia threads unsend`. A message that was delivered stays delivered whatever the order of the two lines, and an unsent one never reaches a model, `read_thread` included |
| Ratings | `cedia threads rate <id> <up\|down>` appends a `rate` event for the thread's latest answer (its last writer session) or `--session`, with an optional `--note`. It is for picking eval cases; no model ever sees it |
| Compaction | Claude: server-side context editing and on-demand compaction (`compact-2026-09-04`), or a client-side summary of the whole history with thinking stripped; never client-side tool-result clearing or keep-tail, because Claude 5.5-family thinking signatures bind the unedited prefix. Chat Completions and Responses: client side, clear old tool results first, then summarize. Segments stay grep-able |
| Session | Append-only JSONL tree; a `request` event before every model call so each request can be rebuilt from the log. Header values are never logged: names plus value hashes only |
| Protocol | JSONL over stdio; ACP later. `src/protocol/protocol.schema.json` is generated from the protocol types (`bun scripts/protocol-schema.ts`) and `test/fixtures/sessions/` holds recorded faux runs (`bun scripts/session-fixtures.ts`), so clients in other languages generate their types and replay real output; a test fails when either is stale |
| Cache | Target ≥ 90% hit ratio per session with every miss attributed; TTL 5 minutes, 1 hour optional after measuring cost |
| Speed | cedia's own share of a run's time is measured, not assumed: `attempt` events carry `ttftMs` and `ms`, snapshots carry `ms`, and every result has `timing` (wall, model, time to first token, tool, harness, decode tok/s); `evals/run.ts` prints it per model. Speed comes from the model and the number of round trips, so cedia keeps its overhead near zero, runs read-only calls in parallel, and offers Opus 5.5 fast mode as its own model (`opus-fast`: up to 2.5x decode, 2x price, Claude API only) |
| Spend | Warn when daily spend passes $20 |
| Config precedence | flags > env > user `~/.cedia/settings.json` > defaults; arrays union and dedupe. A repo's `.cedia/settings.json` only tightens: deny rules, `zdr`, and declared checks (which grant nothing). A key cedia does not know fails the load, except inside `desktop`, which belongs to the desktop client |
| Public repo marker | A `.cedia/public` file in the repo. Without it, models with `dataPolicy: trains` are refused |
| Old code | No code from cedia-rs (traces to claw_code). From the pi-era package keep `evals/` and use `trust.ts` logic as a reference |

## Architecture

Clients (TUI, headless `-p`, eval runner) talk to the core over one protocol. Inside the core every event is written to the session log first, and the context builder builds the next request from that log, so resume, fork, compaction and evals take the same path.

```
src/
  cli.ts
  core/        no UI; tested with a faux provider
    loop/ session/ context/ providers/ tools/ safety/ trust/ project/ skills/ hooks.ts roles.ts
  protocol/    command and event types + JSONL codec
  clients/     tui/ headless/
evals/         tasks/, run.ts, baseline/
```

Rule enforced by a test: `src/core` and `src/protocol` never import from `src/clients`.

Session files live at `~/.cedia/sessions/<project-slug>/<id>.jsonl`. The first line is a `session` event `{cwd, parentSession?, thread?, role, createdAt}`. The leaf is the last event; a fork is a new file whose first event's `parentId` points into the source.

## Core shapes

These are fixed before stage 1 code is written. Names may change; the information each one carries may not shrink.

```ts
// Assistant content keeps each wire's opaque reasoning payload so it can be replayed byte for byte.
type AssistantBlock =
  | { type: 'text'; text: string; sig?: string }
  | { type: 'thinking'; text: string; opaque?: string; redacted?: boolean }
  | { type: 'tool_use'; id: string; callId?: string; name: string; input: JsonObject; inputError?: string }
  | { type: 'compaction'; text: string; opaque: string }; // a provider-written summary and its signature
// The assistant event records which wire produced it; blocks are only replayed to the same wire.
type AssistantEvent = { kind: 'assistant'; wire: Wire; model: string; blocks: AssistantBlock[]; stop: StopReason; usage: Usage };
type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'aborted' | 'error' | 'compaction';
// Handoff by compaction: the request (`of`: the request whose messages it summarizes) and its outcome in the old
// session; first in the new one, the summary, followed by `kept` copies of the old session's events.
type CompactRequest = { kind: 'compact_request'; of: EventId; bodyHash: string; headers: Record<string, string> };
type Compaction = { kind: 'compaction'; requestId: EventId; stop: StopReason; usage: Usage; block?: CompactionBlock; error?: AttemptError; ms?: number };
type Summary = { kind: 'summary'; session: string; block: CompactionBlock; kept: number };

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
  code: 'rate_limit' | 'overloaded' | 'auth' | 'bad_request' | 'network' | 'timeout' | 'server' | 'context_length' | 'quota';
  status?: number; retryAfterMs?: number; message: string;
};

// Headless result. Exit code 0 only on 'success'.
type HeadlessResult = {
  type: 'result';
  // 'handoff' ends a session, never a run: the client goes on in a new session of the thread.
  subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | 'interrupted' | 'error_unverified_claim' | 'handoff';
  sessionId: string; numTurns: number; usage: Usage; costUsd: number; cacheHitRatio: number; result: string; evidence?: Evidence;
  timing?: Timing; plan?: Step; review?: Step & { verdict: 'approve' | 'changes' | 'unclear'; fixed: boolean };
  thread?: string; sessions?: string[]; subthreads?: number;
  compaction?: { block: CompactionBlock; of: EventId }; // a 'handoff' by compaction
};
type Step = { model: string; via: 'cedia' | 'claude-code'; sessionId: string; costUsd?: number };

// A thread file is append-only JSONL; the thread is the fold of its events (core/project/threads.ts).
type ThreadEvent = { at: string } & (
  | { kind: 'open'; title: string; task: string; parent?: string }
  | { kind: 'session'; sessionId: string; model: string; role: string; why: 'start' | 'resume' | 'handoff' | 'quota' | 'rejected'; path?: string }
  | { kind: 'handoff'; sessionId: string; note: string }
  | { kind: 'message'; id: string; from: string; text: string } // from: a thread id or 'user'
  | { kind: 'delivered'; ids: string[]; sessionId: string }
  | { kind: 'unsend'; ids: string[] } // the user took back messages; a delivered one stays delivered
  | { kind: 'rate'; rating: 'up' | 'down'; sessionId?: string; note?: string } // never reaches a model
  | { kind: 'state'; state: 'working' | 'done' | 'failed' | 'stopped'; result?: string }
  | { kind: 'archived'; archived: boolean });

// Per-model facts the adapters and the loop branch on.
type ModelCapabilities = {
  reasoning: 'anthropic-thinking' | 'reasoning_content' | 'responses-item' | 'none';
  replayReasoning: 'required' | 'forbidden' | 'same-turn';
  parallelToolCalls: boolean; input: ('text' | 'image')[]; effortLevels: string[];
  cacheMinTokens: number; midConversationSystem: boolean; midConversationEffort: boolean; contextWindow: number;
};

type ToolOutput = { text: string; images?: BlobRef[] };
```

Rules that go with the shapes:

- **Abort.** `signal` aborts the stream; the adapter emits `done` with `stop: 'aborted'` and whatever blocks were complete. Unfinished tool calls get synthetic `tool_result`s. The turn ends with `turn_end{reason:'aborted'}`.
- **Retry.** `rate_limit`, `overloaded`, `network`, `timeout` and `server` retry with exponential backoff, at most 5 attempts, honouring `retryAfterMs`. `auth`, `bad_request`, `context_length` and `quota` (HTTP 402, or a 429 whose message says the plan or balance is spent) never retry. Each try is its own `attempt` event.
- **Request event.** Carries model, effort, `toolsHash`, `systemHash`, `bodyHash`, TTL and header names with value hashes. Never header values.
- **Role fallback** starts a new session on the fallback model; it never swaps the model inside a session (cache rule 5).
- **Quota fallback.** A run that ends on a `quota` error continues on its fallback model (`--fallback`, then `fallback` in `~/.cedia/settings.json`, then the built-in `deepseek` → `anthropic/claude-haiku-5-5`; `none` turns it off; a repo cannot set it). The new session has `parentSession`, a logged reminder that the tree may hold part of the work, what is left of the turn and budget limits, and the first session's changed files as writes the done gate must still see verified. The result adds up both sessions' spend and turns. `--on-quota wait:<minutes>` (or `onQuota` in `~/.cedia/settings.json`; a repo cannot set it) first waits in the same session for a spent quota that says when it comes back (a 429 with `retry-after`), up to that many minutes across the run, and falls back only past it; a spent balance (402) says no time and falls back at once. Each wait is an `attempt` and goes on stderr; SIGTERM ends it.
- **Refused history.** A `bad_request` or `context_length` error on a request after the session's first accepted one means the provider no longer takes the session's history (a thinking signature it rejects, a tool call it cannot read back, a context past the window), and resending it fails the same way. cedia never edits history (Claude Code drops all thinking and retries), so the run goes on in a new session on the same model, once per run, the way quota fallback does: `parentSession`, the first session's changed files for the done gate, `recall`, and a logged note that the tree may hold part of the work. A resumed thread whose last session was refused starts a new session instead of resuming it.
- **Malformed turns.** A reply with no text and no tool call (thinking only, or nothing) gets one reminder; a second in a row ends the run with `error_during_execution`, so an earlier turn's text never stands as the result. A `refusal` ends the run with `error_during_execution`. A tool's output is always a string by the time it is logged (an object is JSON, nothing is an error result). Calls in one reply that share an id run once and get one result, since the wire pairs results by id.
- **Mid-conversation system prompt.** Appended as a system message when `midConversationSystem` is true, otherwise as a user text block.
- **Effort escalation.** A session starts at `--effort` (else the model's default) and moves to `--escalate` (default `high`, `off` turns it off) once, the first time the done gate refuses a claim. Only on models with `midConversationEffort` (Anthropic's per-message effort, beta `mid-conversation-output-config-2026-07-01`) and only upward. The change is an `effort` event logged right after the gate's reminder, the user text that carries it (a change waits for a user turn with new input, and a turn of tool results alone is not one); the adapter sends it as a `role: "system"` message with empty content and `output_config.effort`, so the top-level effort and every earlier message stay as sent and the cache holds. Soft checks never escalate. A failed check does not escalate either: the note it needs to carry the change made Haiku 5.5 at `low` give up sooner on `hard-redact-bugs` (refused both gate runs, which pass at `low` without it). Anthropic measured the policy as a re-run: Opus 5.5 at `low` with failures re-run at `high` solved about 97% of SWE-bench Pro for $0.17 a task, against 95% for $0.29 at `high` throughout (`about-claude/models/optimizing-for-cost-and-intelligence.md`).
- **Parallel tools.** Calls whose `ToolSpec.effect` is `read` or `network` run in a bounded pool (8 at a time); `write_workspace` and `exec` run alone, as ordering barriers. `tool_intent` events are written in assistant block order; results go back as one batch (Anthropic requires all results of a turn in one user message).
- **Permission order in the log.** `assistant → permission → tool_intent (only if allowed) → tool_result`. A denied call gets `tool_result{status:'denied'}` and no `tool_intent`.
- **Result in the log.** A run that ends with a result writes it, receipt and evidence included, as `result{result: HeadlessResult}` right after the last `turn_end` of its last writer session, so a client that rebuilds a thread from the files shows its last receipt. It is not streamed as an event (the stream already ends with the result line), and the context builder skips it, so no model sees it. A resumed session goes on after it.
- **Token estimate.** The last response's `usage` plus `chars/4` for the delta; Anthropic `count_tokens` on demand.
- **Faux provider.** A script is an array of assistant messages or factories `(context, state) => AssistantEvent`, emitted as delta-level `StreamEvent`s. It computes `usage` by hashing the prefix it was sent, so `cacheRead` is nonzero exactly when the prefix repeats. Shape modeled on pi's faux provider (MIT); add a NOTICE entry if code is adapted.

Protocol events (core → client): every session event, plus `stream` (the `StreamEvent`s of the current attempt), `turn_end` and `result`. Commands (client → core): `prompt`, `abort`, `resume`, `fork`. There is no permission reply: cedia never stops to ask.

## Cache rules

Taken from the DeepSeek harness (`packages/core/agent-loop/README.md`, "KV Cache effect") and Claude Code's prompt caching docs.

1. The prefix stays byte-identical: tools in a fixed order, system prompt sections in a fixed order, no paths or per-process values in the cached part.
2. A system prompt change mid-session is appended as a system message, never written into message 0.
3. The tool list is frozen at the first request; later tools come through tool search or an appended announcement.
4. Cancelled tool calls get synthetic results appended; history is never cut.
5. Roles change only when a subagent starts. The main session never switches model; each subagent owns its cache.
6. A session waiting on a long tool (a work sub-thread, a slow check) keeps its prefix cached: on Anthropic, while tools run past 4 minutes after a request was sent, the same body goes again with `max_tokens: 0` and no stream every 4 minutes, which refreshes the 5-minute cache at the cache-read price instead of writing the whole context again on the next request. Each refresh is a `keepalive` event with its usage, counted in the session's cost.

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

## Desktop client

cedian (`pongsathonkheereekaew/cedian`) is the native macOS desktop for cedia: it runs cedia, draws its threads as panes and never runs an agent loop of its own. What it builds on, and what it may not do:

- Shapes come from `src/protocol/protocol.schema.json`; replays come from `test/fixtures/sessions/`. A change to either is a deliberate regeneration in the same PR as the type change.
- `cedia --version --json` prints `VersionInfo`: the version, `protocol` (the first 16 hex digits of the sha256 of the `protocol.schema.json` the build carries, so the desktop can tell whether its pinned schema matches) and `capabilities`, the features a client may branch on. A capability is added when its feature lands and never renamed.
- A prompt is one run: `cedia -p <text> --thread <id> --output-format stream-json`, in the thread's worktree. Text sent while it works goes in with `cedia threads send`, delivered at the next turn boundary, and `cedia threads unsend` takes it back until then; SIGTERM aborts. The user's 👍/👎 goes in with `cedia threads rate`.
- The receipt of a thread's last run is the last `result` event in its sessions' logs; the live stream's final line is the same object.
- Thread and session files are cedia's to write. The desktop reads and indexes them and changes them only through cedia commands.
- `~/.cedia/settings.json` is the one settings file. The desktop's own keys live under `desktop`; everything else is cedia's schema.
- Images and video in a thread go to a model that reads images: a new session on Haiku 5.5 when the code model is text-only (decided 2026-10-21; not built yet).

## Model roles

| Role | pstack roles it serves | Default |
|---|---|---|
| `plan` | judgment and prose, hardest tasks, how explainer, why synthesizer, reflect judgment | Claude top-tier, effort medium |
| `code` | feature/refactoring, bug-fix, perf-issue, hillclimb, how explorer, why investigators | DeepSeek V4.1 Flash, fallback Haiku 5.5 |
| `smol` | classifier, `/goal` judge, input repair, titles, commit messages | Haiku 5.5 |
| `swarm` | swarm workers, explore sub-threads, reflect tooling | beam-free, then DeepSeek V4.1 Flash |
| `panel` | arena, architect, interrogate, cross-judge | Claude + DeepSeek V4 Pro; Muse only on public repos |
| `advisor` | reviews the `code` role each turn (from oh-my-pi) | Claude, low effort, read-only |

## Trust

Guarantees that hold whatever model runs come from the log, not the model's words.

- **Done gate** (`core/trust/ledger.ts`, stage 2). When the agent claims done and the ledger has no passing declared check after its last write, cedia appends one reminder naming the checks and lets the model continue; a second unverified claim ends the run with `error_unverified_claim` and exit code 1. Only declared checks count (`--check`, or `checks` in `~/.cedia/settings.json` or the repo's `.cedia/settings.json`), and only when the bash command is exactly the check: a pipe would hide its exit code. Writes are completed `edit`/`write` calls and any bash command that is not read-only. With no declared checks the gate is off and the receipt lists everything as unverified.
- **Slop guard** (`core/trust/slop.ts`). When the agent claims done, cedia reads the run's own changes (the patch between its first and latest snapshot, or the edit/write calls without snapshots) for the shortcuts that make work look done: tests deleted, weakened (net assertion lines removed) or skipped, `@ts-ignore`/`eslint-disable`/`# type: ignore`/`noqa`, empty `catch`/`except: pass`, `as any`, and not-implemented stubs. Prose files are not scanned. One reminder lists them; the model fixes each or explains it, and the receipt lists what is left as `flagged`. `--unlock slop-check` turns it off. The layering follows poteto's "trust your agents" pyramid: code and static checks first, prose rules after, human review last.
- **Review** (`core/trust/review.ts`, `--review <model>`). After the writer's claim passes the done gate, a second model reviews the change in its own session (`role: 'review'`): read and bash only, under a read-only policy that also allows the declared checks, given the task, the receipt and the writer's diff from its snapshots (left out past 60k characters). It ends with `VERDICT: approve` or `VERDICT: changes`; changes go back to the writer's own session once, framed as claims to check. The result carries `review{model, sessionId, verdict, fixed}` and adds up every session's spend and turns. The last layer of the pyramid: checks and the slop guard come first.
- **Detected checks.** With no declared check, cedia uses the repo's own test command (`package.json` test script, `cargo test`, `go test ./...`, `make test`, `pytest`). Detected checks are soft: the gate reminds once and never refuses, because the repo's tests may already fail.
- **Receipt.** Every turn that changed files ends with a receipt from the ledger: files changed, checks run, their results.
- **Deny list** (`core/safety/policy.ts`, stage 2, before the stage-6 classifier): force-push (including `--force-with-lease`, `+refspec`, branch deletion), `git reset --hard` and `git clean -f` (any branch until shadow snapshots can undo them), commands that lose commits (`git stash drop|clear`, `git branch -D`, `git reflog expire|delete`, `git update-ref -d`, `git filter-branch`, `git filter-repo`), `rm -r` or `find -delete` outside the workspace or on targets that cannot be resolved, and publish/deploy commands (`npm publish`, `vercel --prod`, `kubectl apply`, `terraform apply`, `gh pr merge` and similar). It reads each simple command, through `sudo`, `nice -n`, `timeout`, `xargs`, `bash -c`, `$( )` and chains. No mode or allow rule lifts it; the user can unlock one guard by name. pstack's "Always pause" list is a harness rule because a weak model will not pause on its own. It guards against mistakes; the sandbox is the boundary.
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

cedia itself is proprietary (`LICENSE`, all rights reserved; `package.json` says `UNLICENSED`). The GitHub repo is public for free CI minutes, which makes the source visible, not licensed. Only take in third-party code whose license allows a closed-source project: MIT, BSD, Apache-2.0 and the like, never GPL/AGPL. Keep `NOTICE` for adapted Apache-2.0 or MIT code. Never copy from `anthropics/claude-code` (no license) or leaked sources, and never port cedia-rs code.
