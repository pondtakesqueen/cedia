# Ink TUI M2e — Polish to 90%+ (feature surface + rendering quality) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Raise ink TUI feature surface and rendering quality from ~80%/60% to 90%+ by closing the remaining gaps: true virtualization, settings search, permission router expansion, vim dot-repeat + find edge cases, accessibility flat-text mode.

**Architecture:** React/ink + existing modules. Upgrade rendering to windowed virtual list with overscan and scroll. Add settings search. Expand permission router. Extend vim with dot-repeat and find edge cases. Gate decorative elements behind screenReader.

**Tech Stack:** Bun, React, ink, existing modules.

**Spec:** `docs/history/ink-tui/specs/2026-10-26-ink-tui-design.md` (M2b/M2c/M2d).

## Global Constraints

- `bun x tsc --noEmit` clean.
- `bun test test/tui-ink-boot.test.ts` green.
- Only `src/clients/tui-ink/*` and `src/clients/tui/vim/*` modified.
- No new runtime dependency.

---

### Task 1: True virtualization (windowed list with overscan + scroll)

**Files:** Modify `src/clients/tui-ink/app.tsx`

Upgrade from simple slicing to a windowed virtual list: render a fixed window of messages (based on terminal rows) with overscan above/below. Track scrollOffset. Add scroll indicator (↑ N more / ↓ N more). Handle PageUp/PageDown/Home/End.

- [ ] Compute window size from rows (rows - 6 for chrome).
- [ ] Render window with overscan (5 above, 5 below).
- [ ] Add scroll indicator.
- [ ] Handle Home/End keys.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): true virtualization with overscan + scroll (M2e)"

### Task 2: Settings search in Config tab

**Files:** Modify `src/clients/tui-ink/app.tsx`

Add search input in Config tab: filter settings keys by query. Type to filter, Esc clears.

- [ ] Add `settingsQuery` state.
- [ ] Filter settings keys by query in Config tab render.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): settings search in Config tab (M2e)"

### Task 3: Permission router expansion

**Files:** Modify `src/clients/tui-ink/app.tsx`

Expand `toolLabel` and add specialized deny messages for more tool types: FileWrite, Skill, EnterPlanMode, ExitPlanMode, Filesystem, Sed, Fallback. Ensure deny message includes tool label + rule + reason.

- [ ] Expand toolLabel mapping.
- [ ] Add per-tool deny message formatting.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): permission router expansion (M2e)"

### Task 4: Vim dot-repeat + find edge cases (t/T, ;, ,)

**Files:** Modify `src/clients/tui/vim/transitions.ts` and `src/clients/tui-ink/vim-input.tsx`

Add dot-repeat: store last change command, replay on '.'. Add find edge cases: t/T (move till before/after char), ; (repeat last find), , (repeat last find reverse). Update VimInput to handle these.

- [ ] Store lastChange in VimInput state.
- [ ] Implement t/T/;/, in transitions and VimInput.
- [ ] Implement dot-repeat replay.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): vim dot-repeat + find edge cases (M2e)"

### Task 5: Accessibility flat-text mode (full)

**Files:** Modify `src/clients/tui-ink/app.tsx`

Gate ALL decorative elements behind `!screenReader`: borders, spinners, colors, markdown styling, box drawing. When screenReader, render plain flat text with role prefixes.

- [ ] Audit all JSX for decorative elements.
- [ ] Gate them behind !screenReader.
- [ ] Add flat-text rendering for messages (role: text).
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): full accessibility flat-text mode (M2e)"

---

## Self-Review
Spec coverage: true virtualization, settings search, permission router expansion, vim dot-repeat + find edge cases, accessibility flat-text.

## Execution Handoff
Execute with subagent-driven-development. Task 1 first.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Created file successfully: docs/history/ink-tui/plans/2026-10-26-ink-tui-m2e-polish.md