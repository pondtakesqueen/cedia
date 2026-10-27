# GAP_ANALYSIS_CC.md — What cedia can learn from Claude Code

Compares `cedia` (its own SPEC.md) against Claude Code (docs/history/CLONE_SPEC.md) to identify
features worth adopting to make cedia more complete/powerful. Not a clone plan.

## Already comparable (no action needed)
- Tool set core (read/edit/write/bash/grep/glob), permissions modes, sandbox,
  MCP client, skills, hooks, memory, compaction/handoff, sub-threads, worktree
  spawn, browser (CDP), web_fetch, todo, ask_user, profiles, schedules,
  coordinator, LSP diagnostics, image blobs, cost tracking, goal mode,
  auto-mode classifier, best-of-N.

## High-value gaps to consider adopting

### A. TUI / UX
1. **Vim mode** in editor (`/vim`, NORMAL/INSERT, operators, text objects).
   cedia uses pi-tui; need to check if pi-tui supports vim. If not, add layer.
2. **Keybindings customization** file (`~/.cedia/keybindings.json`) with chord
   support and contexts.
3. **User-configured status line command** (`settings.statusLine`) emitting
   `StatusLineCommandInput` JSON.
4. **Doctor screen** (`cedia doctor`) with versions, settings errors, MCP warnings,
   sandbox info.
5. **Onboarding/trust dialog** flow (theme, api key, security notes).
6. **Prompt suggestions** (predicted next user prompt after each turn) — useful
   for TUI.
7. **Output styles** (explanatory/learning) as selectable.

### B. Advanced tooling
8. **NotebookEdit** (Jupyter) tool.
9. **PowerShell** tool (Windows).
10. **WebSearch** built-in (cedia intentionally delegates to MCP; could add
    optional).
11. **ToolSearch / deferred tools** for large MCP tool sets.
12. **Sleep tool** (wait).
13. **Monitor tool** (v2.1.310) — watch background process.
14. **Computer-use tool** (desktop control) — maybe via MCP instead.

### C. Memory & context
15. **AutoDream** consolidation (background memory consolidation with lock file).
16. **extractMemories** background fork writing durable memories automatically.
17. **Session memory summary** (summary.md per session) — cedia has handoff note;
    could persist.
18. **MagicDocs** (auto-updating docs with `# MAGIC DOC:` header).
19. **AgentSummary** periodic summaries for subagent UI.

### D. Settings / enterprise
20. **Managed settings** (MDM, remote managed settings, policy limits) — cedia
    has user settings only. Add managed tier for org deployments.
21. **Settings sync** (cloud upload/download of settings+memory).
22. **Plugin marketplace** + install/uninstall/enable/disable commands.
23. **Plugin-provided LSP servers** (cedia already has LSP; extend to plugins).
24. **Output styles as plugins**.

### E. Sessions / remote
25. **Background agents** (`--bg`, attach, logs, stop, respawn) — cedia has
    threads; add daemon attach.
26. **Cloud sessions** (`--cloud`, `--environment`) — remote execution.
27. **Remote control / bridge** for IDE integration.
28. **Teleport** (resume cloud session locally).
29. **System prompt snapshot** (record once, reuse verbatim) — cedia keeps
    prefix byte-identical already; formalize.
30. **Exclude dynamic system prompt sections** for cache reuse across users.

### F. Compaction / caching
31. **Context collapse / microcompact / reactive compact** layers (cedia has
    handoff; could add cheaper in-session compaction).
32. **Prompt caching scope (global/org)** with 1h TTL option.
33. **Cache break detection** monitoring.

### G. Agent orchestration
34. **Agent teams** (TeamCreate/TeamDelete + swarm teammates with shared task
    list) — beyond sub-threads.
35. **Advisor tool** (secondary model advice).
36. **Brief / SendUserMessage** tool for agent→user messaging (cedia has
    progress; could add).
37. **Ultrareview / ultraplan** cloud multi-agent review.

### H. Security / compliance
38. **HIPAA-style managed settings example** (already can reuse from official
    repo).
39. **Credential hiding** in sandbox env (cedia already denies secret paths;
    extend to env vars list like CC).
40. **Cross-session inbound** control.

## Recommended priority for cedia (not clone)

Tier 1 (high leverage, fits cedia's philosophy):
- AutoDream + extractMemories (memory quality)
- Context collapse / microcompact (cost)
- Managed settings tier (enterprise)
- Plugin marketplace (ecosystem)
- Keybindings + vim mode (UX)
- Background agents attach (UX)

Tier 2 (nice to have):
- Output styles, prompt suggestions, doctor screen, status line command
- NotebookEdit, ToolSearch, Sleep, Monitor

Tier 3 (maybe skip / defer):
- Voice, buddy, Chrome extension, computer-use, cloud sessions, ultrareview
  (cedia's scope is terminal harness; these are product-level)

## How to proceed
For each Tier 1 item, write a mini-spec in cedia's style (data shapes first,
tests, done-criteria) and implement behind a flag. Reuse official repo examples
as fixtures/templates only, never code.

## All tiers in scope (single main harness)

If cedia is the single main harness, Tier 3 is in scope but as optional modules
behind flags. See docs/history/IMPLEMENTATION_PLAN.md §6–§8 for phases 7–10. Do not start
Tier 3 until Tier 1–2 are green and daily workflow is stable. Re-evaluate
after each phase.


## Tier 1 completion (documented deferrals)
- Tier 1 #1 AutoDream: IMPLEMENTED (`cedia memory consolidate`).
- Tier 1 #2 client-side microcompact: REJECTED (cache hit collapse; see research/microcompact-probe.md).
- Tier 1 #2 server-side context_management: DEFERRED (optional, gated).
- Tier 1 #3 MDM plist/HKLM/HKCU + remote fetch/polling: DEFERRED (platform-specific); file-based managed settings implemented.
- Tier 1 #4 Plugin marketplace: IMPLEMENTED (local).
- Tier 1 #5 Keybindings + vim + status line + doctor: IMPLEMENTED (adapter).
- Tier 1 #6 Background agents: IMPLEMENTED (attach basic).
Tier 1 status: COMPLETE (with documented deferrals).


## Tier 2.5 / Remote / TUI polish (documented deferrals)
- extractMemories: IMPLEMENTED (`cedia memory extract`).
- Remote control (R1) and TUI polish pass: DEFERRED (large; local daemon + web UI and visual polish to be scheduled).
