# cedia spec

cedia is a personal coding harness built as a pi package. It runs the original pstack (`cursor/plugins/pstack`) on Claude, GPT and Grok. The goal is a harness the user can trust: every "done" is backed by evidence the harness itself recorded, and cedia is good enough on the user's own work that no other harness is worth reaching for, proven by a scoreboard against Claude Code, Codex, Grok Build, opencode and oh-my-pi.

## Trust

Trust comes from the harness's records, never from the model's self-report.

| Mechanism | What it does | Milestone |
|---|---|---|
| Evidence ledger | Records every file change (edit, write, and bash commands that touch the tree) and every check command after it, with exit code and output tail. | M0 |
| Claim check | A turn that claims done, fixed or passing while the ledger shows changes after the last passing check, or that narrates an action ("ran the tests") with no matching tool call, gets one continuation: do it, or say plainly what is unverified. At most 1 per turn. | M0 |
| Receipt footer | Append a footer generated from the ledger to the final message: files changed, checks run with exit codes, what was not verified. The model does not write it. `/receipt` shows the full ledger. | M0 |
| Irreversible-action gate | Fixed deny/ask list (force-push, deploy, broad `rm -rf`, publishing, sending messages) pauses for the user in every mode, enforced by `tool_call`. | M0 |
| Gate classifier | Ambiguous commands go to Haiku `low` with a prompt adapted from Grok Build's `auto_mode_classifier_system_prompt.md`. Only harness-recorded user turns authorize. | M1 |
| Visible failures | Tool errors and retries are shown verbatim; nothing is retried silently. | M0 |
| Goal mode | `/goal <outcome>`: acceptance criteria written to a plan file → work → the harness runs the stated check itself → a readonly adversarial verifier in a fresh context tries to refute it → fix and re-verify only the delta. Adapt only the planner and the code-change verifier lens from Grok Build; the receipt replaces its summarizer. | M1 |
| Reproduced findings | A reviewer finding is shown only with evidence that reruns (`path:line` or command output). | M1 |

**Bounds.** Every loop has a hard cap and ends with an honest report, never with silent extra work: continuation 2, claim check 1, status reminder 2 per turn; goal mode 3 verify rounds, then stop and report what is met and what is not.

Decisions were settled in a grilling session on 2026-10-16. Evidence and source paths are in `research/NOTES.md`.

## Shape

- cedia is one pi package (extension + config) plus thin CLI wrappers (`bin/cedia`, `bin/cedia-update`) that exec `pi` with `PI_CODING_AGENT_DIR=~/.cedia`. No fork.
- Base: `@earendil-works/pi-coding-agent`, pinned to exactly `1.3.0`. Bump by hand after the smoke set passes.
- TypeScript on Node, installed with `npm link`.
- Config and sessions: `~/.cedia/` and project `.cedia/`.
- Surfaces: pi's TUI and headless `cedia -p`.

## Models and auth

| Vendor | Route | Use |
|---|---|---|
| Anthropic | API key (`ANTHROPIC_API_KEY`) only | Small tasks: `claude-haiku-5-5` @`low`. Everything else, including pstack roles: `claude-opus-5-5` @`medium` |
| OpenAI | Sign in with ChatGPT via pi-ai provider `openai-chatgpt` (dynamic client, `ext_agent_host_id`) | Plan usage, no per-token cost |
| xAI | API key (`XAI_API_KEY`) | `grok-4.7` |

Not used: Claude.ai OAuth (Anthropic forbids it in third-party apps, see `research/docs/claude-code/legal-and-compliance.md`), Cursor login (no public API; existing implementations impersonate the Cursor client), OpenCode Zen, pi-ai `openai-codex` (borrows Codex's client id).

Cost guard: status line shows session and daily spend; warn when daily spend passes $20.

Provider layer: pi-ai as is. Add Anthropic `thinking.display: "updates"` through `before_provider_request` only if the smoke set shows Opus/Haiku going silent between tool calls.

## pstack

`bin/cedia-setup` installs the original pstack (sparse clone of `cursor/plugins` into `~/.cedia/packages/`, fast-forward on rerun) and lists its skills in `~/.cedia/settings.json`. Do not edit its files. Skills whose `name` is a display name (`Poteto Mode`, `Make Bot UI`) are loaded from a regenerated copy in `~/.cedia/skill-fixes/` with only the `name` line set to the directory name, because pi registers names verbatim and `/poteto-mode` would not resolve. pstack wins name collisions with `~/.agents/skills/` (`tdd`, `teach`). cedia supplies what Cursor supplied:

1. `Task` and `AskQuestion` tools with the original names and parameter shapes (`subagent_type`, `run_in_background`, `readonly`, `model`). Adapt the code from pstack-claude's Pi extension (MIT, `pi/*.ts`) rather than writing it from scratch. One child process per subagent via pi's `rpc-entry`, at most 4 concurrent, nesting depth 3 (the deepest layer gets no `Task`), `isolation: "worktree"` under `.cedia/worktrees/`, `readonly` removes `edit` and `write`.
2. Cursor model names through `pi.registerVirtualModel()`, e.g. `claude-opus-5-5-xhigh` → `anthropic/claude-opus-5-5 @xhigh`, `grok-4.7-xhigh-fast` → `xai/grok-4.7 @xhigh`.
3. `prompts/cedia-tools.md`, injected as the `<cedia-tools>` system prompt section on every run (same text each time, so the cached prefix holds), mapping Cursor paths and tools to cedia's (`.cursor/rules/pstack-models.mdc` → `~/.cedia/pstack-models.md`, `.cursor/projects/` → `~/.cedia/sessions/`, `.cursor/skills/` → skill dirs).

The original pstack names only these models: `grok-4.7-xhigh-fast` (code default), `grok-4.7-medium-fast`, `claude-opus-5-5-xhigh` (prose and judgment default), `claude-opus-5-5-medium`, `claude-opus-5-5-max`. The virtual-model table maps all of them to `anthropic/claude-opus-5-5 @medium`. A `cedia/auto` virtual model routes small tasks to Haiku `low` and the rest to Opus `medium`; the scoreboard decides the routing rule. Role overrides live in `~/.cedia/pstack-models.md`, written by pstack's `/setup-pstack`.

Claude Code keeps using pstack-claude; cedia does not touch it.

## Compatibility

Agent Skills (`SKILL.md`), `AGENTS.md` with `CLAUDE.md` fallback, MCP (built into pi), plugins per the `agent-plugins.org` 1.0.0 schema (skills and agents). opencode config is not read.

## M0 behaviors

All built as pi extension hooks.

| Behavior | Hook |
|---|---|
| Text-only end of turn with open todos → send a continuation naming them, at most 2 in a row. Only in headless mode, `/loop`, or "run until done". | `agent_before_settle` → `continue: true` |
| 5 tool steps with nothing for the user to read → append "say in a few words what you're doing, then continue". At most 2 per turn. All modes. | `tool_result` + `pi.sendMessage()` |
| A new user message during work steers the current task. | pi steering (default) |
| Compaction writes a handoff: pi's own checkpoint summary plus open todos, unverified files, suggested skills (from `SKILL.md` reads), artifact paths instead of copies, prompt-level redaction. Stored as pi's compaction entry in the session. | `session_before_compact` → pi's exported `compact()` with the session's `streamSimple` |
| `/handoff [focus]` triggers the same compaction with a focus. A command instead of the planned skill: the instructions live in `src/handoff.ts`, so a command reuses them with no second copy. | `registerCommand` |
| `TodoWrite`; plan mode is a readonly permission profile. | `registerTool`, tool exposure |

System prompt: pi's default + pstack. Variants (a base adapted from Grok Build's `prompt.md`, per-family overlays) are experiments that must beat the baseline on the smoke set.

## Milestones

- **M0.** Trust mechanisms marked M0 above, per-request telemetry (input, output, cache read, cache write, $, wall time from each vendor's `usage`), scoreboard runner, pstack and its translation layer (`AskQuestion`, virtual models, `cedia-tools.md`), M0 behaviors, cost guard.
- **M1.** Goal mode, gate classifier, reproduced findings, `Task` subagents with a time-budget line (`elapsed 340s / 1200s`) on messages to children.
- **M2.** MCP, LSP diagnostics after edit, `WebFetch` (ours) and web search through each vendor's server tool.
- **M3.** Sandbox: macOS Seatbelt plus allow/deny rules.
- **M4.** Checkpoints: shadow git under `~/.cedia/checkpoints/` with `/undo`.

Read the matching Claude Code, Codex and Grok Build docs and source at the start of each milestone.

## Deferred until evidence

Each of these waits for a measured trigger:

- Model capability registry: when a second per-family difference has been accepted.
- Custom provider adapters: when pi-ai blocks a needed feature.
- Shell-command hooks: implemented via `CEDIA_HOOKS` (pre_tool and post_tool), `src/hooks.ts`. Trigger met by user request, not by evidence.
- Cross-session memory: when the same context has to be repeated across sessions.
- `<pasted_content>` tagging: pi's editor expands paste markers (`[paste #1 +40 lines]`, only for pastes over 10 lines or 1,000 chars) before the `input` hook fires, so pasted text is indistinguishable from typed text. Revisit when pi exposes paste spans on `input`, or if cedia ever replaces pi's editor.
- Automations (benny): dropped; use `cedia -p` + cron if ever needed.

## Scoreboard

The scoreboard is the product's core. Every change is a hillclimb step (pstack's hillclimb playbook): one hypothesis, before/after on the scoreboard, one commit per accepted win.

| Metric | Source |
|---|---|
| False-done rate (most important) | tasks where cedia said done but the grader failed |
| Review precision | reviewer findings that reproduce / findings shown |
| Task pass rate | user's own tasks (8-10) + Terminal-Bench smoke set |
| Cache hit | `cache_read / total input` per request |
| Cost | $ per passed task |
| Speed | wall time per task |
| Stability | crashes and hangs per 100 tasks |
| Unconfirmed irreversible actions | must be 0 |

Harnesses compared weekly on the same tasks and models: cedia, plain pi, Claude Code, Codex, Grok Build, opencode, oh-my-pi (all have a headless mode). Their token spend counts toward the budget.

"Good enough to stop looking": cedia wins or ties every row on the user's tasks and is within 5% of the best on Terminal-Bench.

First experiments, A/B on the scoreboard:
1. Handoff compaction vs each vendor's server compaction (cache hit, pass rate).
2. Per-family edit tool (`apply_patch` for GPT and Grok, string replace for Claude) vs pi's `edit` for all.
3. Cache discipline: all tools declared from turn one, no system prompt edits mid-session, `clear_at` reminders, per-message effort changes, `prompt_cache_key`, Anthropic 1-hour TTL.

## Eval

- Smoke set: 8 Terminal-Bench tasks spread over bug fix, feature, refactor, long-running and multi-file work. Run on the default model after each prompt or tool change, on all three families weekly. Set the per-run budget after the first measured run.
- Baseline: plain pi on the same model every run; Claude Code and Codex periodically.
- Tests for cedia itself: vitest for pure logic, headless e2e with pi-ai's `faux` provider for `Task`, `AskQuestion`, handoff and the continuation rules.
- Done for M0: the scoreboard runs end to end against every listed harness and cedia is ≥ plain pi on every row.

## Licenses

Keep a `NOTICE` for adapted code: pstack-claude (MIT), Grok Build and Codex (Apache-2.0) if their prompts are adapted, oh-my-pi (MIT) if any code is ported. Never copy from `anthropics/claude-code` (no license) or from leaked sources.
