# cedia spec

cedia is a personal coding harness built as a pi package. It runs the original pstack (`cursor/plugins/pstack`) on Claude, GPT and Grok, and it must score at least as well as plain pi on the same model before it replaces pi as the daily driver.

Decisions were settled in a grilling session on 2026-10-16. Evidence and source paths are in `research/NOTES.md`.

## Shape

- cedia is one pi package (extension + config) plus `bin/cedia`, which runs `pi` with `PI_CODING_AGENT_DIR=~/.cedia`. No CLI wrapper and no fork.
- Base: `@earendil-works/pi-coding-agent`, pinned to exactly `1.3.0`. Bump by hand after the smoke set passes.
- TypeScript on Node, installed with `npm link`.
- Config and sessions: `~/.cedia/` and project `.cedia/`.
- Surfaces: pi's TUI and headless `cedia -p`.

## Models and auth

| Vendor | Route | Use |
|---|---|---|
| Anthropic | API key (`ANTHROPIC_API_KEY`) only | Default session model: `claude-haiku-5-5` at effort `low` |
| OpenAI | Sign in with ChatGPT via pi-ai provider `openai-chatgpt` (dynamic client, `ext_agent_host_id`) | Plan usage, no per-token cost |
| xAI | API key (`XAI_API_KEY`) | `grok-4.7` |

Not used: Claude.ai OAuth (Anthropic forbids it in third-party apps, see `research/docs/claude-code/legal-and-compliance.md`), Cursor login (no public API; existing implementations impersonate the Cursor client), OpenCode Zen, pi-ai `openai-codex` (borrows Codex's client id).

Cost guard: status line shows session and daily spend; warn when daily spend passes $20.

Provider layer: pi-ai as is. Add Anthropic `thinking.display: "updates"` through `before_provider_request` only if the smoke set shows Opus/Haiku going silent between tool calls.

## pstack

Install the original pstack from `cursor/plugins/pstack` with `pi install` / the `skills` setting. Do not edit its files. cedia supplies what Cursor supplied:

1. `Task` and `AskQuestion` tools with the original names and parameter shapes (`subagent_type`, `run_in_background`, `readonly`, `model`). Adapt the code from pstack-claude's Pi extension (MIT, `pi/*.ts`) rather than writing it from scratch. One child process per subagent via pi's `rpc-entry`, at most 4 concurrent, nesting depth 3 (the deepest layer gets no `Task`), `isolation: "worktree"` under `.cedia/worktrees/`, `readonly` removes `edit` and `write`.
2. Cursor model names through `pi.registerVirtualModel()`, e.g. `claude-opus-5-5-xhigh` → `anthropic/claude-opus-5-5 @xhigh`, `grok-4.7-xhigh-fast` → `xai/grok-4.7 @xhigh`.
3. `cedia-tools.md`, injected into the system prompt, mapping Cursor paths and tools to cedia's (`.cursor/rules/pstack-models.mdc` → `~/.cedia/pstack-models.md`, `.cursor/projects/` → `~/.cedia/sessions/`, `.cursor/skills/` → skill dirs).

The original pstack names only these models: `grok-4.7-xhigh-fast` (code default), `grok-4.7-medium-fast`, `claude-opus-5-5-xhigh` (prose and judgment default), `claude-opus-5-5-medium`, `claude-opus-5-5-max`. The virtual-model table covers exactly these. Role overrides live in `~/.cedia/pstack-models.md`, written by pstack's `/setup-pstack`.

Claude Code keeps using pstack-claude; cedia does not touch it.

## Compatibility

Agent Skills (`SKILL.md`), `AGENTS.md` with `CLAUDE.md` fallback, MCP (built into pi), plugins per the `agent-plugins.org` 1.0.0 schema (skills and agents). opencode config is not read.

## M0 behaviors

All built as pi extension hooks.

| Behavior | Hook |
|---|---|
| Text-only end of turn with open todos → send a continuation naming them, at most 2 in a row. Only in headless mode, `/loop`, or "run until done". | `agent_before_settle` → `continue: true` |
| 5 tool steps with nothing for the user to read → append "say in a few words what you're doing, then continue". At most 2 per turn. All modes. | `tool_result` + `pi.sendMessage()` |
| Wrap pasted text in `<pasted_content id="…">` and add the matching system note. | `input` |
| A new user message during work steers the current task. | pi steering (default) |
| Compaction writes a handoff: current focus, todos, suggested skills, artifact paths instead of copies, prompt-level redaction. Stored at `~/.cedia/sessions/<id>/handoffs/`. | `session_before_compact` |
| `/handoff [focus]` uses the same template. | a skill, not a command |
| `TodoWrite`; plan mode is a readonly permission profile. | `registerTool`, tool exposure |

System prompt: pi's default + pstack. Variants (a base adapted from Grok Build's `prompt.md`, per-family overlays) are experiments that must beat the baseline on the smoke set.

## Milestones

- **M0.** pstack installed and its translation layer (`AskQuestion`, virtual models, `cedia-tools.md`), M0 behaviors, cost guard, smoke set and baseline.
- **M1.** `Task` subagents with a time-budget line (`elapsed 340s / 1200s`) on messages to children.
- **M2.** MCP, LSP diagnostics after edit, `WebFetch` (ours) and web search through each vendor's server tool.
- **M3.** Sandbox: macOS Seatbelt plus allow/deny rules.
- **M4.** Checkpoints: shadow git under `~/.cedia/checkpoints/` with `/undo`.

Read the matching Claude Code, Codex and Grok Build docs and source at the start of each milestone.

## Deferred until evidence

Each of these waits for a measured trigger:

- Per-family edit tool and model capability registry: when GPT or Grok edits fail noticeably more than Claude on the smoke set.
- Custom provider adapters / server-side compaction: when pi-ai blocks a needed feature.
- Shell-command hooks: when the first hook is needed.
- Cross-session memory: when the same context has to be repeated across sessions.
- Automations (benny): dropped; use `cedia -p` + cron if ever needed.

## Eval

- Smoke set: 8 Terminal-Bench tasks spread over bug fix, feature, refactor, long-running and multi-file work. Run on the default model after each prompt or tool change, on all three families weekly. Set the per-run budget after the first measured run.
- Baseline: plain pi on the same model every run; Claude Code and Codex periodically.
- Tests for cedia itself: vitest for pure logic, headless e2e with pi-ai's `faux` provider for `Task`, `AskQuestion`, handoff and the continuation rules.
- Done for M0: smoke score ≥ plain pi on the same model, and one full week of daily use without switching back.

## Licenses

Keep a `NOTICE` for adapted code: pstack-claude (MIT), Grok Build and Codex (Apache-2.0) if their prompts are adapted, oh-my-pi (MIT) if any code is ported. Never copy from `anthropics/claude-code` (no license) or from leaked sources.
