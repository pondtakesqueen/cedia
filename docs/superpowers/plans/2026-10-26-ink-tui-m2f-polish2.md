# Ink TUI M2f — Polish to 95% (permission dialogs, virtualization, keybindings, settings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Close the remaining gaps for 95%: specialized permission dialogs per tool type, true virtualization, keybindings contexts, settings page completeness.

**Architecture:** React/ink + existing modules. Add permission dialog components. Upgrade message list to true windowed virtualization. Add keybinding contexts. Complete settings page (Status/Config/Usage with search + per-model usage).

**Tech Stack:** Bun, React, ink, existing modules.

**Spec:** `docs/superpowers/specs/2026-10-26-ink-tui-design.md` + docs/TUI_AUDIT.md.

## Global Constraints

- `bun x tsc --noEmit` clean.
- `bun test test/tui-ink-boot.test.ts` green.
- Only `src/clients/tui-ink/*` and `src/clients/tui/*` modified.
- No new runtime dependency.

---

### Task 1: Specialized permission dialogs

**Files:** Create `src/clients/tui-ink/permission-dialogs.tsx`, modify `app.tsx`

Create specialized dialog components for: FileWrite, Skill, EnterPlanMode, ExitPlanMode, Filesystem, Sed, Fallback. Each shows tool name, input preview, allow/deny. Wire into permission deny handler (informational, since cedia auto-decides).

- [ ] Create permission-dialogs.tsx with components.
- [ ] Wire into app.tsx.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): specialized permission dialogs (M2f)"

### Task 2: True virtualization (VirtualMessageList)

**Files:** Modify `src/clients/tui-ink/app.tsx`

Replace slicing with a true windowed virtual list: render only visible window + overscan, recycle components. Use a fixed-size container with overflow hidden. Track scrollTop.

- [ ] Implement virtual list with overscan 3.
- [ ] Add scroll position indicator.
- [ ] Handle PageUp/PageDown/Home/End.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): true virtualization (M2f)"

### Task 3: Keybindings contexts

**Files:** Modify `src/clients/tui-ink/app.tsx`, `src/clients/tui/keybindings/resolver.ts`

Add contexts: Autocomplete, Confirmation, Tabs, Transcript, Task, Scroll, Help. Apply context-based resolution in useInput. Wire contexts to focused dialog.

- [ ] Add context param to resolveBindings calls.
- [ ] Apply based on focusedDialog.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): keybindings contexts (M2f)"

### Task 4: Settings page completeness

**Files:** Modify `src/clients/tui-ink/app.tsx`

Complete settings tabs: Status (model/permission/thread/context/spend/vim/running), Config (searchable settings keys + edit), Usage (per-model spend breakdown from session logs).

- [ ] Enhance Status tab.
- [ ] Enhance Config tab with search (already) + edit value.
- [ ] Enhance Usage tab with per-model breakdown.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): settings page completeness (M2f)"

---

## Self-Review
Spec coverage: permission dialogs, true virtualization, keybindings contexts, settings page completeness.

## Execution Handoff
Execute with subagent-driven-development. Task 1 first.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Created file successfully: docs/superpowers/plans/2026-10-26-ink-tui-m2f-polish2.md