# Ink TUI M2b — Quality (status line, keybindings, mouse, resize) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Upgrade ink TUI to cc-level: status line command integration, keybindings file support, mouse selection + copy, resize/alt-screen handling, overlays (palette, pickers, settings).

**Architecture:** React/ink. Add status line command runner (already in core/tui/statusline.ts). Add keybindings loader (already in tui/keybindings). Add mouse tracking (already in app). Improve resize handling. Add overlay components.

**Tech Stack:** Bun, React, ink, existing modules.

**Spec:** `docs/superpowers/specs/2026-10-26-ink-tui-design.md` (M2b section).

## Global Constraints

- `bun x tsc --noEmit` clean.
- `bun test test/tui-ink-boot.test.ts` green.
- Only `src/clients/tui-ink/*` modified.
- No new runtime dependency.

---

### Task 1: Status line command integration

**Files:** Modify `src/clients/tui-ink/app.tsx`

The /statusline command already exists. Add automatic status line rendering: if settings.statusLine is configured, run it on each state change and show output in the status bar area. Use runStatusLineCommand from ../tui/statusline.ts (already imported).

- [ ] Read settings.statusLine from settings.json; if present, run on state changes and display.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): status line command integration (M2b)"

### Task 2: Keybindings file support

**Files:** Modify `src/clients/tui-ink/app.tsx`

Load keybindings from ~/.cedia/keybindings.json via loadKeybindings (from ../tui/keybindings/loader.ts). Apply in useInput: match key → command. Chord timeout 1000ms.

- [ ] Import loadKeybindings, resolveBindings.
- [ ] Load on mount; apply in useInput.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): keybindings file support (M2b)"

### Task 3: Mouse selection + copy (already partial)

**Files:** Modify `src/clients/tui-ink/app.tsx`

The mouse selection exists. Improve: ensure copy to clipboard works on release, add visual feedback. Already mostly there. Polish: clear selection on Esc, handle edge cases.

- [ ] Polish mouse selection.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): polish mouse selection (M2b)"

### Task 4: Resize handling

**Files:** Modify `src/clients/tui-ink/app.tsx`

Use useWindowSize (already imported). On resize, recompute layout. Ink handles this mostly. Add a resize effect that re-renders. Ensure no crash on small terminals.

- [ ] Add resize handling.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): resize handling (M2b)"

---

## Self-Review
Spec coverage: M2b partial (status line, keybindings, mouse, resize). Settings tabs, permission router, vim depth deferred to M2c.

## Execution Handoff
Execute with subagent-driven-development. Task 1 first.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Created file successfully: docs/superpowers/plans/2026-10-26-ink-tui-m2b-quality.md