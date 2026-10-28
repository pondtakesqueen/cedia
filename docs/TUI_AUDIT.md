# TUI Audit: cedia (ink) vs Claude Code (cc) vs Codex CLI

Date: 2026-10-26. Scope: `src/clients/tui-ink/app.tsx` (ink TUI, default) vs history/CLONE_SPEC.md §16 + GAP_ANALYSIS_CC.md.

## 1. Slash commands

### cc built-ins (from history/CLONE_SPEC §2.4)
| cc command | cedia ink | status |
|---|---|---|
| /diff | ✅ | |
| /undo | ✅ | |
| /redo | ✅ | |
| /commit | ✅ | |
| /pr | ✅ | |
| /review | ✅ | |
| /new | ✅ | |
| /thread | ✅ | |
| /model | ✅ | |
| /goal | ✅ | |
| /help | ✅ | |
| /quit | ✅ | |
| /vim | ✅ | |
| /memory | ✅ | |
| /compact | ✅ (info only) | cc: actual compaction |
| /context | ✅ | |
| /cost | ✅ | |
| /doctor | ✅ (basic) | cc: versions, settings errors, keybinding warnings, MCP warnings, sandbox |
| /config | ✅ | |
| /permissions | ⚠️ /permission (singular) | rename to /permissions? |
| /hooks | ✅ | |
| /mcp | ✅ | |
| /plugin | ❌ | not implemented (Tier 3) |
| /agents | ✅ | |
| /tasks | ✅ | |
| /resume | ✅ | |
| /rename | ✅ | |
| /export | ✅ | |
| /share | ❌ | not implemented |
| /clear | ✅ | |
| /color | ❌ (alias /theme?) | cc has /color |
| /theme | ✅ | |
| /effort | ✅ (info only) | cc: sets effort |
| /fast | ✅ (info only) | cc: toggles fast mode |
| /output-style | ✅ | |
| /passes | ❌ | cc-specific |
| /privacy-settings | ❌ | cc-specific |
| /release-notes | ❌ | cc-specific |
| /sandbox-toggle | ❌ | could be useful |
| /status | ✅ | |
| /stats | ❌ | cc: usage stats |
| /tag | ❌ | cc-specific |
| /terminalSetup | ❌ | could be useful |
| /thinkback | ❌ | cc-specific |
| /ctx_viz | ❌ | cc: context visualization |
| /files | ❌ | cc: list files in context |
| /copy | ✅ | |
| /branch | ✅ | |
| /rewind | ✅ | |
| /btw | ✅ | |
| /palette | ✅ | |
| /suggest | ✅ | |
| /trust | ✅ | |
| /onboarding | ✅ | |
| /statusline | ✅ | |
| /plan | ✅ | |
| /quick | ✅ | |
| /goal | ✅ | |

### 2. Screens & overlays

| cc feature | cedia ink | status |
|---|---|---|
| REPL main screen | ✅ | |
| Message list (Messages/VirtualMessageList) | ✅ | height budget + overscan + slot recycle |
| PromptInput | ✅ (VimInput) | |
| Transcript toggle | ✅ | |
| History search | ✅ (Ctrl+R) | |
| Message selector / rewind | ✅ (Ctrl+O) | |
| Surveys | ❌ deferred | |
| Cost/idle dialogs | ✅ basic | |
| Permission/tool JSX overlays | ⚠️ | no specialized per-tool dialogs |
| Ultrapan | ✅ /plan | no choice dialog |
| Desktop upsell | ❌ deferred | |
| Doctor screen | ✅ basic | |
| Resume conversation picker | ✅ | |
| Focused dialog priority | ✅ basic | |
| Settings tabs (Status/Config/Usage) | ✅ | |
| Settings search | ✅ (Config tab) | |
| Onboarding (preflight/theme/api-key/oauth/security/terminal) | ⚠️ basic | missing Grove, Claude-in-Chrome, bypass/auto-mode opt-in, dev channels |
| Trust dialog | ✅ | |
| Keybindings (contexts/chords/overrides) | ✅ | overlay contexts + `g g` chord in vim normal |
| Vim mode (motions/text objects/find/counts/dot-repeat) | ✅ | |
| Status line (command) | ✅ | |
| Ink renderer (Yoga/scheduleRender/Frame diff) | ✅ | incrementalRendering + maxFps 60 + SIGCONT redraw + suspendTerminal editor |
| Accessibility (--ax-screen-reader) | ✅ | |
| Mouse/selection | ✅ | |
| Resize/alt-screen | ✅ | |

### 3. Permission dialogs

| cc tool dialog | cedia ink | status |
|---|---|---|
| Bash | ✅ | |
| PowerShell | N/A | no PowerShell tool |
| FileEdit | ✅ (edit) | |
| FileWrite | ✅ | path + line count + content preview |
| WebFetch | ✅ | |
| Notebook | ❌ | no NotebookEdit tool |
| Skill | ✅ | name / args / file fields |
| AskUserQuestion | ✅ | |
| EnterPlanMode | ✅ | action + plan preview |
| ExitPlanMode | ✅ | action + plan preview |
| Filesystem | ✅ | op / path / destination fields |
| Sed | ✅ | expression + path |
| Fallback | ⚠️ | JSON / input dump |

### 4. Codex CLI comparison (general knowledge)

Codex CLI (OpenAI) TUI features:
| Codex feature | cedia ink | status |
|---|---|---|
| Interactive REPL | ✅ | |
| Slash commands | ✅ (47+) | |
| Model switching (/model) | ✅ | |
| Permission modes | ✅ | |
| File editing (apply_patch) | ✅ (edit/write) | |
| Shell commands | ✅ (bash) | |
| Web search | ⚠️ | via MCP, not built-in |
| Image input | ✅ (--image, read image) | |
| Session resume/fork | ✅ (/thread, /fork, /resume, /rewind) | |
| MCP servers | ✅ | |
| Skills | ✅ | |
| Memory/AGENTS.md | ✅ | |
| Sandbox | ✅ | |
| Diff view | ✅ (/diff) | |
| Undo/redo | ✅ | |
| Commit/PR | ✅ (/commit, /pr) | |
| Review | ✅ (/review) | |
| Goal mode | ✅ (/goal) | codex doesn't have this |
| Plan mode | ✅ (/plan, /quick) | |
| Vim mode | ✅ | codex: basic |
| History search | ✅ (Ctrl+R) | |
| Mouse selection | ✅ | |
| Accessibility | ✅ | codex: basic |
| Status line | ✅ | |
| Onboarding | ✅ | |
| Doctor | ✅ | |
| Cost tracking | ✅ | |
| Context compaction | ✅ (auto handoff) | |
| Multi-agent/sub-threads | ✅ (spawn, /tasks, /agents) | codex: basic |
| Browser tool | ✅ | |
| LSP diagnostics | ✅ | |
| Image generation | ❌ | not implemented |
| Voice | ❌ deferred | |

### 5. Summary: gaps to close for 95%+

**High priority (functional gaps):**
1. Permission router: specialized dialogs for FileWrite, Skill, PlanMode, Filesystem, Sed — ✅ NoticeBlock layouts (diff/preview/fields)
2. True virtualization: VirtualMessageList overscan + recycling — ✅ height cache + slot recycle
3. Keybindings: missing contexts — ✅ overlay contexts + chord wiring (`g g`)
4. Onboarding: add Grove, Claude-in-Chrome, bypass/auto-mode opt-in, dev channels — deferred (CC product)
5. Selection overlay: inline search highlight + message selection overlay — ✅ paintRuns + fullySelected chrome

**Medium priority (polish):**
6. Ink renderer: tune scheduleRender, Frame diff, SIGCONT, pause/resume — ✅ incrementalRendering, maxFps 60, SIGCONT redraw, suspendTerminal for Ctrl+G
7. Vim: visual mode? (cc has it; cedia doesn't) — visual mode landed earlier; confirm remaining gaps
8. Settings: search mode in Config (done), but Usage tab could show per-model breakdown
9. Accessibility: manual testing with screen reader

**Low priority (deferred by design):**
10. Surveys, desktop upsell, ultrapan choice dialogs
11. Voice/buddy/computer-use (Tier 2)
12. Plugin marketplace, remote/cloud (Tier 3)
13. /passes, /privacy-settings, /release-notes, /sandbox-toggle, /stats, /tag, /terminalSetup, /thinkback, /ctx_viz, /files, /share, /plugin, /color (cc-specific or low value)

### 6. Feature surface score: ~90%

**Done:** ~47 commands, virtual list, history search, message selector, transcript toggle, cost/idle dialogs, dialog priority, status line, keybindings, mouse, resize, onboarding, accessibility, resume picker, settings tabs+search, permission router (expanded labels), vim depth (motions/operators/text objects/find/counts/dot-repeat), rewind, LSP, full goal mode, classifier, spawn display, markdown, tool cards, permission dialogs, Tab autocomplete, arrow-key navigation.

**Missing for 95%:** CC-product onboarding (Grove/Chrome/bypass) among the former high list; remaining medium: Usage per-model, a11y manual pass, any leftover vim visual gaps.

**Missing for 100% (deferred):** voice/buddy/computer-use, plugin/remote/cloud, surveys, desktop upsell, ultrapan choice, cc-specific commands. (cedia doesn't need all of these — some are cc-specific.)
## Update 2026-10-26 (ink TUI polish round)
- Theme tokens (dark/light, original values) applied: user rows, selection, dialogs, borders, diff colors, errors, status line.
- `/theme <dark|light>` switches live and persists.
- Fixes: duplicate stdin handler removed (double-input bug), Esc/Ctrl+C abort, no more `unknown command /historyUp` (real input history), /model /effort /output-style /theme actually apply, shift+tab cycles permission mode.
- New: transcript search UI (Ctrl+F), @-file mentions, visual vim mode, multiline input, thinking toggle (Meta+T), frecency-ranked autocomplete, draft stash per thread, structured diff rendering, windowed virtual list by estimated rows, input history, external editor (Ctrl+G).

## Update 2026-10-27 (ink TUI polish)

- Transcript search Enter jumps and leaves the overlay and the query up. Esc closes and clears the query. Idle Enter no longer submits the draft while search is open.
- Mouse, wheel, selection, and copy use the display-message index from the paint walk. Hit rows, including assistant rows, highlight the query.
- A denial notice lists bash, edit, write, web_fetch, and skill fields. It does not print Allow or Deny.
- Onboarding is complete only when every `ONBOARDING_STEPS` name is recorded. `reconcileOnboarding` only appends.

## Update 2026-10-28 (ink TUI polish round 2)

- Denial notices name plan mode, filesystem, and sed fields; write shows a line count; skill shows args.
- Overlay keys resolve through `DEFAULT_BINDINGS` for Autocomplete, Confirmation, Select, Settings, MessageSelector, HistorySearch, and Transcript, so `keybindings.json` can rebind them.
- Transcript paint composes selection and search hits via `paintRuns`, using theme tokens for selection and hit chrome.

## Update 2026-10-28 (ink TUI virtual window)

- Transcript windowing uses `visibleWindow` with a height budget, message overscan of 3, and a `createHeightCache` map keyed by index/width/text length/role.
- Slot recycle via `assignRecycleSlots` keeps stable React keys (`slot-N`) across window slides.

## Update 2026-10-28 (ink permission layouts)

- Denial notices use `NoticeBlock` layouts: edit shows `-`/`+` diff rows, write and plan mode show a capped content preview, other tools keep specialized fields.
- Still one dialog shell; no Allow/Deny captions (denial-only).

## Update 2026-10-28 (ink chord wiring)

- `ChordInterceptor` returns `none` for non-prefixes so typing is not swallowed.
- Multi-key bindings (`g g`) resolve through `chordsFromBindings` / `matchChord`.
- In vim normal mode, Chat runs the interceptor before single-key bindings; default `g g` scrolls to the top.

## Update 2026-10-28 (ink message selection chrome)

- A display message covered end-to-end by the mouse selection gets `selectedBg` row chrome via `messageFullySelected`.

## Update 2026-10-28 (ink renderer schedule / Frame-diff)

- `inkRenderOptions` turns on `incrementalRendering` and `maxFps: 60` for the interactive TUI.
- `SIGCONT` clears Ink's recorded frame and notifies the App to commit a fresh paint after `fg`.
- Ctrl+G hands the TTY to `$EDITOR` through Ink's `suspendTerminal`, which restores the alternate screen and force-redraws.
