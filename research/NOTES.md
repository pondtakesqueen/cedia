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

## Not yet read in depth
Claude Code, Codex and Grok Build feature pages (subagents, hooks, permissions, sandbox, checkpoints, plan mode, memory). Read the matching pages from all three when each milestone starts.
