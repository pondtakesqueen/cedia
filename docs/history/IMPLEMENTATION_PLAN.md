# IMPLEMENTATION_PLAN.md — Filling the Claude Code clone to completion

Companion to `CLONE_SPEC.md`. Goal: turn the empty `~/cedia/claude-code/` skeleton
into a working clone, prioritizing reusable reference material and closing gaps.

## 0. Reusable reference material (no code copying; study + reimplement)

Source repo: `https://github.com/anthropics/claude-code` (license: © Anthropic, all
rights reserved — reference only, do not copy into the clone).

| Artifact | Location | Reuse value |
|---|---|---|
| Built-in mods source | `mods/agents-md`, `mods/diff`, `mods/telemetry`, `mods/sec-default` | Reference implementation of plugin hook model (`register(on, options)`, engine events `$`, noun contracts). Study for plugin system + `/diff`, AGENTS.md loading, telemetry, sec-default. |
| Plugin examples | `plugins/*` (agent-sdk-dev, code-review, feature-dev, hookify, plugin-dev, pr-review-toolkit, ralph-wiggum, security-guidance, …) | Plugin manifest (`plugin.json`), command/agent/hook layout, frontmatter. Use as test fixtures for plugin loader. |
| Hook examples | `examples/hooks/bash_command_validator_example.py` | Hook stdin/stdout contract example. |
| Settings examples | `examples/settings/*` (lax, strict, bash-sandbox, hipaa, managed-mcp-hipaa) | Concrete managed-settings JSON; validates settings schema & HIPAA deployment. |
| MDM templates | `examples/mdm/*` | Jamf/Intune/GPO deployment templates. |
| Gateway examples | `examples/gateway/aws`, `examples/gateway/gcp` | Enterprise auth/telemetry gateway setup (Terraform). |
| Mod test harness docs | `mods/README.md` | Plugin test kit (`claude plugin test`), mock nouns, tier system — spec for our test harness. |
| CHANGELOG.md | root | Feature/version history; use to track what v2.1.304→2.1.310 added (Monitor tool, plugin monitors, compaction fixes, sandbox fixes, etc.). |
| CLAUDE.md | root | Project instructions format reference. |

Also reusable from our own environment:
- `claude` binary 2.1.304 at `/opt/homebrew/bin/claude` for black-box study (run
  `--help`, observe config dirs, network via REA).
- Leaked source tree (already in `/Users/pond/Downloads/cc/claude-code-source-code-leak-main`)
  as spec evidence — not copied.
- `morluto/rea` for binary reverse engineering of gaps.

## 1. Gap closure tasks (from CLONE_SPEC §23 UNKNOWN)

Priority order:

1. **Hook config schema & event list** — study `examples/hooks`, leaked
   `src/utils/hooks/*`, managed settings examples. Define `hooks` in settings
   with PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart/SessionEnd and
   command/prompt/agent/http types.
2. **Plugin manifest schema** — study `plugins/*/.claude-plugin/plugin.json` and
   mods. Define plugin loader inputs (commands, agents, output styles, hooks,
   MCP servers, LSP servers).
3. **Session JSONL event schema** — inspect `~/.claude/projects/*/*.jsonl` from
   the installed binary. Document all event types (session, user, assistant,
   tool_use, tool_result, system, compact, fork). Reuse as fixture format for
   `test/fixtures/sessions/`.
4. **MCP handshake details** — run `claude mcp` / connect a test server; capture
   with REA if needed.
5. **Auto-mode classifier prompt** — study `--auto-mode defaults/config/critique`
   subcommand output.
6. **Voice, buddy, bridge wire protocol** — black-box via REA or defer to v2.
7. **Cloud sessions / background agents lifecycle** — black-box; defer to v2.
8. **Ultrareview/ultraplan** — defer to v2.

## 2. Implementation phases

### Phase 1 — Runnable skeleton (1–2 weeks)
- Add `package.json`, `tsconfig.json`, Bun config to `~/cedia/claude-code/`.
- Install deps: `@anthropic-ai/sdk`, `react`, `ink`, `@anthropic-ai/sandbox-runtime`,
  `zod`, `commander`, `chalk`, `diff`, `ripgrep` (optional).
- Implement entrypoint `src/entrypoints/cli.tsx` + `src/main.tsx` with commander,
  flags from CLONE_SPEC §2.2, dispatch to interactive vs print.
- Deliverable: `claude-clone --version`, `--help`, `-p "hi"` round-trips to API.

### Phase 2 — Core agent loop (2–3 weeks)
- `src/QueryEngine.ts`, `src/query.ts`, `src/context.ts`, `src/bootstrap/state.ts`.
- Streaming tool execution, tool orchestration.
- Cost tracking.
- Deliverable: single-turn file edit via Read/Edit/Bash works in print mode.

### Phase 3 — Tools (2–3 weeks)
- Implement all built-in tools per CLONE_SPEC §5.2 with Zod schemas.
- Permission system §6 (modes + rules + trust dialog).
- Sandbox integration.
- Deliverable: interactive REPL can edit/run tests.

### Phase 4 — TUI (2 weeks)
- Ink renderer, REPL screen, PromptInput, message list, permission dialogs.
- Keybindings, vim mode (can reuse state machine spec).
- Status line.
- Deliverable: interactive session usable.

### Phase 5 — Persistence & context (1–2 weeks)
- Session JSONL read/write/resume/fork.
- CLAUDE.md loading, auto-memory, session memory.
- Compaction layers.
- Deliverable: resume continues; compaction triggers.

### Phase 6 — MCP, LSP, plugins, skills (2 weeks)
- MCP client (stdio + HTTP).
- LSP via plugins.
- Plugin loader + skill loader.
- Hooks runner.
- Deliverable: MCP server tools callable; skills load.

### Phase 7 — Advanced (defer)
- Coordinator mode, teams, background agents, voice, bridge, remote, cloud,
  ultrareview/ultraplan, buddy.

## 3. Testing strategy

- Unit tests per tool with faux provider (offline).
- Session fixture tests: record golden JSONL, fail if drift (as cedia does).
- Protocol schema generation.
- E2E with `CLAUDE_CODE_SIMPLE=1` (bare) mode.
- Use mods' test-harness pattern (mock nouns) for plugin tests.

## 4. Clean-room compliance

- No code/assets copied from Anthropic Claude Code (no license) or leaked source.
- Adapted third-party Apache-2.0/MIT code → `NOTICE` entry.
- REA used only for black-box study; document findings with addresses/strings.
- All implementation written fresh from CLONE_SPEC.md.

## 5. Definition of "complete (v1)"

A clone is "complete (v1)" when:
- All Phase 1–6 deliverables pass.
- `--help` matches v2.1.304 flag set (§2.2).
- Interactive REPL + print mode + resume + MCP + skills + hooks + plugins work.
- Compaction + memory + cost tracking work.
- Test suite green offline.
- UNKNOWN list in CLONE_SPEC §23 reduced to deferred-only items.

## 6. Extended scope: all tiers (cedia as single main harness)

If the goal is a single main harness with full parity (not just clone), extend
with Tier 3 product features as optional modules. Each is behind a flag so core
stays lean. Do NOT start these until Phase 1–6 are green.

### Phase 7 — Background agents & remote control (2–3 weeks)
- `--bg/--background`, `attach`, `logs`, `stop|kill`, `rm`, `respawn`.
- Daemon process management, worktree orchestration, log streaming (IPC).
- `--remote-control/--rc` WebSocket/stdio bridge for IDE integration.
- `--teleport` (resume cloud session locally).
- Deliverable: background session can be started, attached, stopped; remote
  control connects to VS Code.

### Phase 8 — Chrome extension & computer-use (2–3 weeks)
- Chrome extension (native messaging host) + `--chrome/--no-chrome`.
- Computer-use tool: screen capture, mouse/keyboard control, OS accessibility
  permissions (macOS/Windows/Linux).
- Deliverable: `--chrome` connects to extension; computer-use tool captures
  and interacts with screen.

### Phase 9 — Voice & buddy (2–3 weeks)
- Voice mode: audio capture (mic), STT, TTS; cross-platform.
- Buddy/companion: UI animation, state persistence, personality.
- `/voice` command, voice input in PromptInput.
- Deliverable: voice input works in REPL; buddy renders.

### Phase 10 — Cloud sessions & ultrareview (3–4 weeks)
- `--cloud`, `--environment`: cloud execution environment.
- `--ultrareview`: multi-agent cloud code review.
- Cloud session protocol, billing, sandboxed execution.
- Deliverable: cloud session can be created and attached.

## 7. Optional module rules

- Each Tier 3 feature is a separate module loaded only when its flag is on.
- Core harness must start fast and stay lean when flags are off.
- No Tier 3 dependency may be required for core build/test.
- Each module has its own tests (offline where possible; cloud features
  require network and are marked integration).
- Maintenance burden: OS-specific (audio, accessibility, sandbox) — budget
  ongoing fixes.

## 8. Recommended order (single harness)

1. Phase 1–6 (core) — must complete first.
2. Phase 7 (background/remote) — highest value for daily use.
3. Phase 8 (Chrome/computer-use) — useful for browser testing.
4. Phase 9 (voice/buddy) — UX polish, can defer.
5. Phase 10 (cloud/ultrareview) — last; requires infra.

Skip any phase that does not serve daily coding workflow. Re-evaluate after
each phase whether the next is worth the cost.
