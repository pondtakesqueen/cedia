# Research notes for cedia

Sources read on 2026-10-16. Mirrored docs live in `docs/` (refresh with `./mirror-docs.sh`); cloned repos live in `src/` (gitignored).

| Corpus | Pages | License |
|---|---|---|
| `docs/claude-code` | 228 | docs |
| `docs/claude-platform` | 309 | docs |
| `docs/codex` | 186 | docs |
| `docs/openai-api` | 213 | docs |
| `docs/xai` (incl. Grok Build) | 104 | docs |
| `src/codex` (openai/codex) | Rust | Apache-2.0 |
| `src/grok-build` (xai-org/grok-build) | Rust | Apache-2.0 |
| `src/claude-code` (anthropics/claude-code) | plugins, examples | no license: read only, copy nothing |
| `src/claude-code-harness` | Claude Code 2.1.292 binary RE docs (01–07 + closings-A–D, README map) | no license: read only, copy nothing |

Later notes, read 2026-10-22, each paraphrased with nothing copied:

- [`system-prompts-notes.md`](system-prompts-notes.md): Anthropic's published claude.ai system prompts, all models, used for per-model prompt tuning.
- [`claude-code-prompts-notes.md`](claude-code-prompts-notes.md): Claude Code 2.1.307's prompts as extracted in Piebald-AI/claude-code-system-prompts.
- [`claude-code-docs-notes.md`](claude-code-docs-notes.md): the Agent SDK docs, the What's new digests, legal and compliance, and the CLI reference.

Excluded on purpose: `tanbiralam/claude-code` (leaked proprietary source) and leaked Cursor prompts.

## Provider APIs

### Anthropic (Claude 5.x)
- Thinking is always on for Opus 5.5; `effort` is the main control, default `medium`. Changing top-level `effort` invalidates the cache; use the per-message effort change (beta) instead. `docs/claude-platform/build-with-claude/effort.md`
- `max_tokens` 128k recommended for long agentic turns; thinking counts toward it.
- Progress updates between tool calls arrive as `thinking` blocks, empty unless `display: "updates"` (beta `thinking-display-updates-2026-08-18`).
- Server compaction: on-demand (`compact-2026-09-04`, top-level `compaction` param) and threshold modes; can keep recent turns word for word and keep their thinking. Client-side summaries invalidate preserved thinking in kept turns. `build-with-claude/compaction*.md`
- Context editing clears old tool results/thinking by rule. `build-with-claude/context-editing.md`
- Turn-scoped mid-conversation system messages (`clear_at: "next_user_message"`, beta `mid-conversation-system-clear-at-2026-08-21`) keep the cache valid.
- Adding a tool or changing the system prompt mid-session invalidates earlier thinking blocks: declare every tool and every standing instruction from the first request.

### OpenAI (GPT-6 family, Responses API)
- Server compaction via `context_management.compact_threshold`; emits an opaque encrypted compaction item; drop items before it. `docs/openai-api/guides/compaction.md`
- New in GPT-6: async tool calling (`async: true`, reply by `call_id`), mid-turn steering over WebSocket, `configuration_update` input item to change reasoning effort without breaking cache. `guides/latest-model/gpt-6-astra.md`
- GPT-6 Astra asks more clarifying questions and is more sensitive to skill/AGENTS.md text; delegates less than wanted unless prompted.
- Native tools the models are trained on: `apply_patch` (freeform), `shell`, `tool_search`. `guides/tools-*.md`

### xAI (Grok 4.7)
- Responses API (OpenAI-compatible, `https://api.x.ai/v1`), 500k context, reasoning low/medium/high(default)/xhigh.
- Set `prompt_cache_key` (Responses) or `x-grok-conv-id` (Chat Completions) or caching is unreliable.
- Encrypted reasoning is always returned; pass reasoning items back unchanged.
- `/responses/compact` returns one opaque compaction item. `developers/advanced-api-usage/context-compaction.md`
- Grok 4.7 Fast exists only in Cursor and Grok Build, not on the public API, so Cursor's `grok-4.7-xhigh-fast` maps to `grok-4.7` at `xhigh`.

### pi-ai 1.3.0 coverage (grep of `dist/`)
- Has: `prompt_cache_key`, `encrypted_content`, `effort`, `reasoning_effort`, websocket, `faux` provider (usable for e2e tests). xAI goes through `openAIResponsesApi`.
- Missing: Anthropic `compact-2026` / `context_management` / `clear_at` / `display: "updates"`, OpenAI `context_management` compaction, xAI `/responses/compact`.

## Harness designs

### Codex (`src/codex/codex-rs`)
- Per-model capability registry `models-manager/models.json`: `apply_patch_tool_type`, `shell_type`, `truncation_policy` (tool output 10k tokens), `context_window`, `auto_compact_token_limit`, `supports_parallel_tool_calls`, `tool_mode` (`code_mode_only` for GPT-6: the model orchestrates tools from JS in `functions.exec` with `Promise.allSettled`), reasoning levels, plus `model_messages` with the instructions template and per-model fragments (tools, approvals, permissions, multi_agent, collaboration_modes).
- GPT-6 instructions template is ~3,300 words: permission policy, autonomy and persistence, commentary vs final channels, steering semantics, compaction continuity, skills usage rules.
- Compaction prompt: "Create a handoff summary for another LLM that will resume the task." `prompts/templates/compact/prompt.md`

### Grok Build (`src/grok-build/crates`)
- System prompt `codegen/xai-grok-agent/templates/prompt.md` (119 lines) is a template keyed on tool *kinds* (`tools.by_kind.task`, `.execute`, `.monitor`…) and modes (`is_non_interactive`, memory, browser verification). Sections: dangerous_actions, work_policy, memory, background_tasks, scratch_files, communication, formatting.
- Separate `subagent_prompt.md` and `apply_patch_prompt.md` (Grok also edits by apply_patch).
- Compaction crate has inter-turn compaction (7-section summary, keeps all user messages) and intra-turn compaction (summarizes only the tool-call history of the current turn), plus code compaction. `common/xai-grok-compaction/`
- Auto-mode permission classifier prompt: `codegen/xai-grok-workspace/templates/auto_mode_classifier_system_prompt.md`.
- Feature docs mirror Claude Code's surface: subagents, hooks, permissions, sandbox, plan mode, worktrees, sessions, skills/plugins/marketplaces, background tasks. `docs/xai/build/`

### oh-my-pi (`src/oh-my-pi`, MIT, Stencil Labs, fork of pi)
- Bun ≥1.3.14 runtime, Rust natives, `@oh-my-pi/pi-ai` 18.11.1 (diverged far from pi 1.3.0). 60+ providers, 31 tools, LSP (14 ops), DAP (28 ops).
- Provider features present: Anthropic `compact-2026` + `context_management` + `clear_at` (`providers/anthropic-wire.ts`, `anthropic-compaction.ts`), OpenAI/xAI `responses/compact` + `configuration_update` (`openai-configuration-update.ts`), `prompt_cache_key`, `x-grok-conv-id`.
- Missing: Anthropic `display: "updates"`, OpenAI Sign in with ChatGPT host id (`ext_agent_host_id`).
- Anthropic API key works (`ANTHROPIC_API_KEY`, `x-api-key`). With an OAuth token it impersonates Claude Code (`providers/claude-code-fingerprint.ts`: spoofed `claude-cli/<ver>` User-Agent, billing header, `check-spoofed-versions` script). Also ships a reverse-engineered Cursor provider. Do not port either.
- Anthropic + Responses provider code is ~20k lines; 5 of those files use Bun APIs.

### Anthropic credential policy
- Claude.ai OAuth is only for Claude Code and native Anthropic apps. Third-party apps may not offer Claude.ai login, route requests through Free/Pro/Max credentials, or store Claude.ai tokens; enforcement may come without notice. API keys billed to their owner are fine. `docs/claude-code/legal-and-compliance.md#authentication-and-credential-use`
- Decision: cedia uses Claude by API key only.

### OpenAI Sign in with ChatGPT
- Official path for open-source/local apps to use a ChatGPT plan: dynamic client registration plus a persisted `ext_agent_host_id` per host. `https://developers.openai.com/siwc/token-sharing-open-source.md`

### opencode (MIT)
- Base prompt + small per-family overlay (`packages/core/src/plugin/system-prompt/*.txt`); tool guidance injected via `${OPENCODE_TOOL_GUIDANCE}`.

## Harness behaviors vendors recommend
- Anthropic: treat a text-only end of turn as a report, not completion; re-prompt with open todo items, cap at 2-3 auto-continuations. `prompting-claude-opus-5-5.md#unattended-agentic-runs`
- Anthropic: after ~5 silent tool steps, append a turn-scoped reminder asking for a status line; stop after 2-3 reminders.
- Anthropic: give subagent teams a time budget line `elapsed 340s / 1200s` on each message.
- Anthropic: wrap user-pasted text in `<pasted_content id="…">` and add the matching system note.
- OpenAI: user instructions outrank skills; when a skill causes a pause, name the SKILL.md and quote the line.
- All three: new user messages during work steer the current task instead of replacing it.

## Trust-related designs (read 2026-10-16)

### Goal loops with a separate judge
- Claude Code `/goal <condition>`: after every turn a fresh model judges the condition from the transcript only (it runs no commands), keeps going until met, judged impossible, or a must-fix error. Conditions should name one measurable end state, the check that proves it, and constraints. `docs/claude-code/goal.md`
- Grok Build goal mode (Apache-2.0), `src/grok-build/crates/codegen/xai-grok-shell/src/session/templates/`:
  - `goal_planner_prompt.md`: runs once, writes a plan file of grouped acceptance criteria and a task checklist; the plan is the single source of truth for "done".
  - `goal_verifier_prompt.md`: adversarial verifier, not the author, tries to refute; defaults to `refuted: true` when uncertain. Kind lenses: `goal_verifier_kind_lens_code_change.md` (read current files, run code, cite `path:line` or transcripts), `_analysis.md` (every claim must cite checkable evidence), `_research.md` (open each cited source).
  - `goal_verifier_resume_prompt.md`: same verifier re-checks only the delta after a fix.
  - `goal_strategist_prompt.md`: after several failed rounds flagging different gaps, recommends one structural change.
  - `goal_task_discipline.md`: narration must be paired with the tool call; no asking permission to continue in-flight work.
  - `goal_summarizer_prompt.md`: writes the closing message only after verification.

### Approval classifiers
- All three vendors gate tool calls with a classifier: Claude Code auto mode (deny/ask rules run first, classifier blocks irreversible, destructive, or out-of-environment actions; trusts cwd and the repo's remotes by default) `docs/claude-code/auto-mode-config.md`; Codex auto-review / guardian `docs/codex/agent-approvals-security.md`, policy text `src/codex/codex-rs/prompts/templates/guardian/policy.md` (Apache-2.0); Grok Build `src/grok-build/crates/codegen/xai-grok-workspace/templates/auto_mode_classifier_system_prompt.md` (15 lines, Apache-2.0: hard-wait vs clearable tiers, only harness-recorded user turns and decisions authorize, judge what the action does, not names).
- Binary-derived mechanics, Claude Code 2.1.292 (`src/claude-code-harness/`, read-only, no license): the classifier runs in two stages, a cheap yes/no block check (~64 tokens) that escalates to full reasoning (~8k) only on "yes"; parse failures and errors deny; 3 consecutive or 20 total denials fall back to a user prompt (headless: abort). Deny/ask rules always run before the classifier, and content ask-rules hold even in bypass mode. Pipeline order is hooks → deny → ask → tool-level permission check → bypass → allow. `05-permissions-hooks.md`, `closings-C.md`
- Same source: after compaction the harness does not re-send standing instructions; it relies on the request-time prepended message. cedia's compaction-handoff should likewise avoid duplicating standing instructions in the handoff. `closings-C.md` (06-Q4)
- Same source: settings merge unions arrays (dedup, never replace) with strictest-wins on managed keys; large tool results are persisted to the session dir with only a small preview pointer entering context. `closings-D.md` (07-Q1), `02-tools-a.md`, `06-context-memory.md`

### Review
- Claude Code ultrareview: multi-agent review where every finding is independently reproduced before it is reported. `docs/claude-code/ultrareview.md`

### Checkpoints
- Claude Code checkpointing does not track files changed by Bash or external edits. `docs/claude-code/checkpointing.md`. cedia's shadow-git snapshot covers both.

## Projects, threads and context (read 2026-10-21)

- Claude Projects, new version (beta, Claude Code first): "a project becomes a single ongoing conversation"; Claude "breaks the work into parallel threads that run in the cloud", which keep going after the laptop closes; "every thread starts with the project's files, repositories, instructions, and memory"; a Library collects files added and produced; running several threads at once uses the plan faster. https://support.claude.com/en/articles/9517075-what-are-projects
- Same feature, seen from inside a thread (cedia was built from one): a coordinator talks to the user and opens threads; a thread gets one event per turn (a user message, a message from the coordinator or another thread, a PR event, a reminder it scheduled); it may message another thread only when one's work depends on the other's; it keeps a visible checklist; it resolves itself when done (hidden, reopenable); project files are a shared folder where the last write wins; project memory is one file per subject. cedia maps these to threads, handoff, `message_thread` (delivered at the next turn boundary), sub-threads that archive themselves, and the repo itself as the shared files. Memory is still stage 4.
- Not done: reverse-engineering the Claude desktop app (for example with REA, https://github.com/morluto/rea, MIT). Anthropic's terms forbid it and cedia takes nothing from Claude Code's internals; the public docs and first-hand use were enough.
- mattpocock/skills `handoff` (MIT, https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff): a handoff document for a fresh agent that references existing artifacts by path instead of copying them, redacts secrets, and is tailored to what the next session will do. cedia's handoff prompt takes the same stance in its own words (point to the log and files; recall searches the rest); redaction is already done on every tool result before it is logged.
- RTK (https://github.com/rtk-ai/rtk): a hook rewrites shell commands to `rtk <cmd>`, which filters, groups, truncates and deduplicates their output (claims 60-90% smaller bash output, measured as bytes/4; the README says the saving dilutes over the whole bill). The CLI is Apache-2.0 but its engine and proxy are BUSL-1.1, so nothing can be adapted into cedia. Rewriting commands would also break the done gate, which counts a check only when the whole command is the declared check. Measured on 264 hard-eval sessions in ~/.cedia/sessions (each event's characters times the requests that re-sent it): bash results are 23% of input, read results 8%, assistant text and thinking 39%. On Haiku a run is about 117k input tokens (85% cached) and 12k output, so input is about a third of the bill and bash output about 7%; even RTK's best case would save 4-6% of a run's cost. Not worth a hook that breaks the done gate. If that share grows, cedia should filter output itself after the ledger has seen the exit code.

## Claude API: cost, long context and handoff (read 2026-10-22)

Re-mirrored `docs/claude-platform` (321 pages), read for what decides where and how a session hands off. Paths are under `docs/claude-platform/`.

- Long context is priced flat on every 1M model except Haiku 5.5, where a prompt over 100k costs 5x (cache reads and writes count toward the length). So on Opus 5.5, Sonnet 5.5 and Fable 5.1 the window says nothing about when to hand off; what does is cost per turn (context times the cache-read price) against what a handoff costs, plus "context rot": "As token count grows, accuracy and recall degrade". `build-with-claude/context-windows.md`, `about-claude/pricing.md`
- Cache reads are 0.1x input, but 0.05x on Opus 5.5 and Sonnet 5.5 and 0.025x on Fable 5.1; writes are 1.25x (5 min) or 2x (1 h). A handoff costs about a note (output) plus the successor's re-read (writes), both proportional to the input price, so the cost-optimal distance between handoffs, about sqrt(2 x handoff cost x tokens per turn / cache-read price), depends on the cache-read ratio only: about 1.4x Haiku's on Opus and Sonnet 5.5, 2x on Fable. With a handoff costing about 57k input tokens' worth (a 4k note at 5x, a 30k re-read written at 1.25x) and 5k tokens a turn, that is about 75k past the session's start at Haiku's ratio, 105k at Opus's and 150k at Fable's; a successor starts at 10k to 30k, so cedia's 150k cap is about right on Opus, Haiku's 100k price line decides there, and window/2 (500k) would be wrong. Not measured yet. `build-with-claude/prompt-caching.md#pricing`
- Thinking stays in context on every 5.x model (Haiku 5.5 included) and is billed as input on later turns; that is how one planning reply takes Haiku from 90k to 150k. `build-with-claude/context-windows.md`
- Server compaction (`compact-2026-09-04`, all 5.x models, Haiku 5.5 included) is the API's version of cedia's handoff: a separate request returns a signed `compaction` block that replaces the summarized messages. Two variants answer the two costs the evals measured for handoff: keep-recent-turns sends the last turns word for word after the block (the successor does not re-read what it was editing), and background compaction writes the summary while the session goes on (no pause for the note). The summarizer reads earlier thinking; custom `instructions` (up to 16,384 characters) can carry cedia's plan-shaped note prompt; its usage is in `usage.iterations`. In cedia it would be a new session that starts with the block and the kept turns, so no log is edited. Anthropic-only, so handoff stays the portable path. `build-with-claude/compaction*.md`
- Context editing (tool-result clearing) invalidates the cache from the cleared point and made a short job 73% dearer in Anthropic's own test; thinking clearing breaks the cache the same way. Not for cedia. `build-with-claude/context-editing.md`, `about-claude/models/optimizing-for-cost-and-intelligence.md`
- The 5-minute cache expires while a session waits: in the long evals every parent that waited over 5 minutes on a work sub-thread re-wrote its whole context on its next request. A `max_tokens: 0` request (not streamed, same prefix, effort and thinking settings) refreshes the cache at cache-read price, every 4 minutes while the parent waits; 1-hour TTL instead costs 2x on every write of the session. At Opus prices a 150k parent pays about $0.03 per refresh against $0.75 for the re-write. `build-with-claude/prompt-caching.md#pre-warming-the-cache`, `about-claude/models/optimizing-for-cost-and-intelligence.md`
- Per-message effort (`mid-conversation-output-config-2026-07-01`, Opus/Sonnet/Haiku 5.5) changes effort in a `role: "system"` message without breaking the cache. With the done gate as the failure signal, cedia could run at `low` or `medium` and raise effort only after a failed check: Anthropic measured 97% at $0.17 per task against 95.3% at $0.29 with everything at `high` (Opus 5.5, SWE-bench Pro). `build-with-claude/effort.md#change-effort-mid-conversation`
- Task budgets (`task-budgets-2026-03-13`) give the model a countdown for one agentic loop, counted on what it sees, not on what is resent; Haiku 5.5 has no context-awareness tags, so this is the only way to tell it how much room is left. A candidate for sub-threads, measured against cedia's own reminders. `build-with-claude/task-budgets.md`
- Mid-conversation tool changes (`inline-tools-2026-09-15`) add or define a tool in a system message with the cache intact: a resumed session could get `recall` or the thread tools without a new session. `build-with-claude/mid-conversation-system-messages.md`
- Opus 5.5 rejects forced `tool_choice` and disabled thinking; Haiku 5.5 rejects sampling parameters and prefill. Thinking replayed after any change to the prefix is a 400 on accounts created from 2026-08-31, which cedia's append-only logs already avoid. `models/opus-5-5/whats-new-opus-5-5.md`, `models/haiku-5-5/whats-new-haiku-5-5.md`

## Choosing a model per role (read 2026-10-23)

Anthropic's "Choosing a model" and "Optimizing for cost and intelligence" pages, Artificial Analysis' per-effort runs of the Claude 5.x models, and cedia's own OpenRouter round. Paths are under `docs/claude-platform/`.

- Effort before model: Anthropic says changing effort usually beats changing model. Opus 5.5 and Haiku 5.5 default to medium; Sonnet 5.5 and Fable 5.1 to high. `about-claude/models/choosing-a-model.md`
- Sonnet 5.5 at medium is weak at agentic coding: 62.7% against 77.8% at high on Anthropic's internal set. On Artificial Analysis' FrontierCode (agentic changes in real repos) Sonnet medium scored 29% against Opus low's 43%, although the two are level on the overall index (41 and 42). `about-claude/models/optimizing-for-cost-and-intelligence.md`
- FrontierCode by effort: Opus medium 57% is the top score, above Opus high and xhigh (54%) and max (52%). Haiku high (44%) and xhigh (45%) equal Sonnet high (44%) at about a tenth of the cost; Haiku low falls to 29%. Fable 5.1 costs the most and scored no better on coding.
- An orchestrator that splits work to smaller models saved money in Anthropic's runs only for routine work with a few unusually long pieces, or work larger than one context window; otherwise one large model at low effort won. Advisors (a small model that asks a large one when stuck) added little, the small model rarely asked, and on coding they cost about 2.1x. This matches cedia's arm (b): the Opus plan did not cut Flash's turns before its first done claim (28-48 against 26-45 alone); the extra turns were the review's fix rounds. `about-claude/models/optimizing-for-cost-and-intelligence.md`
- What the review bought: on every real-* run it caught a real defect Flash left (an unasked fail-open change to policy.ts `real()`, a handoff that lost the thread's task, a quota error that never reached the fallback). Review is worth its turns; planning is not, except for work that splits into independent parts (#84).
- So: plan and review through Claude Code at Opus medium (`claude-code` alone), the writer on DeepSeek Flash, Haiku at high where a Claude writer is needed, and Sonnet nowhere by default.

## Not yet read in depth
Claude Code, Codex and Grok Build feature pages (subagents, hooks, permissions, sandbox, checkpoints, plan mode, memory). Read the matching pages from all three when each milestone starts.

## Claude Code CHANGELOG (read 2026-10-21, up to 2.1.306)

Source: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (no license: ideas only, copy nothing). 426 versions; enterprise, gateway, plugin, mod, IDE and Slack entries left out. Each finding names the version that added or fixed it, and the cedia code it was checked against at 80e9643.

### Open in cedia today (checked in the code)
- Framing tags are not escaped: a sub-thread report, thread message or handoff note that contains `</subthread>`, `</message>` or `</handoff>` closes cedia's frame (`tools/spawn.ts:24`, `project/threads.ts:142`, `clients/headless/main.ts:77`). Claude Code marks subagent output with a header (2.1.277), escapes `<system-reminder>` in hook output (2.1.292), neutralizes markup and invisible characters in memory (2.1.284) and strips invisible Unicode from prompts (2.1.277).
- Bash kills only the shell on timeout or abort, then waits for stdout EOF (`tools/bash.ts:142-145`); a backgrounded child holding the pipe keeps the call open. Claude Code fixed orphaned process trees (2.1.212) and hooks hanging on `daemon &` (2.1.285).
- The sandbox denies writes to `.git/hooks` only when it exists (`safety/sandbox.ts:48`), so bash can create it and plant a hook that runs outside the sandbox on the user's next commit; `core.hooksPath` targets such as `.husky` are not protected. Claude Code protects `.husky` (2.1.90) and asks before writing shell startup files and `~/.config/git` (2.1.160).
- Read-only calls run with `Promise.all` over the whole batch (`loop/run.ts:432-441`), though the spec says a bounded pool; parallel explore sub-threads have no concurrency or per-run cap. Claude Code caps concurrent subagents at 20 (2.1.217) and capped spawns per session at 200 (2.1.212). The per-session cap was removed in W32 (What's new); only the concurrency and depth limits remain.
- The deny list covers push, reset --hard and clean -f; ref-losing commands (`stash drop/clear`, `branch -D`, `reflog expire`, `update-ref -d`, `filter-branch`) are not covered and shadow snapshots cannot restore them. Claude Code blocks `stash drop` and `commit --amend` on commits it did not make (2.1.183).
- Bash output is cut in the middle at 30k characters (`tools/registry.ts:26`); Claude Code saves large output to a file with a preview (2.1.2) and lets the user raise the inline cap (2.1.261).

### Failure classes worth a test each
- Redaction misses Claude Code fixed: invisible character inside a key name and `Bearer`/`Basic` before the key (2.1.286), URL password with `@` or `%40` (2.1.285), key with no value followed by JSON in a shell string (2.1.296), GitLab token families (2.1.232), freezes on long token-like text (2.1.290, twice).
- Sandbox exit codes: Linux sandbox reported 0 for failed commands under zsh (2.1.275). The done gate depends on the exit code.
- Malformed turns: thinking-only reply (2.1.183, 2.1.251), tool name over 200 characters stuck forever (2.1.281), tool result that is not a string (2.1.286), retries ignoring max turns when unparseable calls alternate with max_tokens (2.1.281), unexpected `tool_use_id` loop (2.1.274), unpaired `tool_use` on abort (2.1.218).
- Thinking rejected by the API: Claude Code drops all thinking and retries (2.1.282) after a rejection repeated every turn (2.1.259). cedia cannot edit history, so the matching recovery is a new session from the handoff note, as quota fallback does.
- Cache misses Claude Code fixed by re-rendering less: tool list re-rendered after OAuth refresh (2.1.248), tool changes on resume (2.1.267), memory age note changing per request (2.1.275), attachments re-rendered on resume (2.1.277), effort change (2.1.260 for Fable 5.1). All are prevented in cedia by cache rules 1-3; keep them as faux tests.

### Cost ideas to measure
- Resume of a cold thread: Claude Code warns before resuming an idle conversation (2.1.304), hands hooks the staleness and re-cache cost (2.1.251), and compacts an idle 200k+ conversation before its 1-hour cache expires (2.1.299).
- Stagger same-prefix parallel agents so later ones read the cache the first one wrote (2.1.229).
- Per-session cache line with the likely cause of each miss (2.1.251, 2.1.260, 2.1.280); cedia's request events already hold the hashes to name causes exactly.
- TTL per role: 1 hour for the main session, 5 minutes for subagents (2.1.243), per agent (2.1.248).
- Usage report from logs: warnings for max effort, large tool results and always-on context (2.1.299), unused skills and their context cost (2.1.261).
- Task tools are offered only to older models since 2.1.268; whether Haiku 5.5 or DeepSeek still benefit is an eval question.

### Rules for features cedia has not built yet
- Hooks: fail closed when a hook cannot start, times out or cannot be handed its input (2.1.288, 2.1.295, 2.1.299); re-run every permission check after a hook rewrites input (2.1.290, 2.1.300); escape and cap hook output (2.1.292, 2.1.89, 2.1.247); exec form without a shell (2.1.139); prompt hooks written as instructions were misjudged (2.1.294).
- Classifier: deny rules first; a denial covers the outcome, not the exact command (2.1.281); deny once and say a retry will not help (2.1.280); review subagent spawns and cross-session messages too (2.1.178, 2.1.222); reuse the cached prefix (2.1.221); a too-long transcript is compacted rather than denying every call (2.1.288, 2.1.302); exfiltration through public diagram-renderer URLs (2.1.261) and cloud metadata credentials (2.1.257).
- Worktrees: never remove one with unpushed commits without asking (2.1.301, 2.1.304).
- Session log: Claude Code began recording each request's system prompt, tools and parameters in 2.1.300; cedia logs their hashes and could keep each distinct body once by hash.
