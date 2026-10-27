# Ink TUI M2a — Quality (virtual list, history search, dialogs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Upgrade ink TUI rendering to cc-level: windowed virtual message list (replace slicing), history search (Ctrl+R), message selector + rewind UI, transcript toggle, cost/idle dialogs, focused dialog priority system.

**Architecture:** Keep React/ink. Add a windowed list (render last N with scroll offset, but virtualized via slicing already; upgrade to true windowing with overscan). Add history search overlay (modal). Add message selector overlay. Add cost/idle dialog components. Add dialog priority router (a single `focusedDialog` state with priority order).

**Tech Stack:** Bun, React, ink, existing core modules.

**Spec:** `docs/superpowers/specs/2026-10-26-ink-tui-design.md` (M2a section).

## Global Constraints

- `bun x tsc --noEmit` clean.
- `bun test test/tui-ink-boot.test.ts` green.
- Only `src/clients/tui-ink/*` modified.
- No new runtime dependency.

---

### Task 1: Windowed virtual message list

**Files:** Modify `src/clients/tui-ink/app.tsx`

Replace `messages.slice(...)` rendering with a windowed list that renders a fixed window (e.g., 40 messages) based on scrollOffset, with overscan. Currently already slices last 40. Upgrade: compute window start = max(0, messages.length - 40 - scrollOffset), end = messages.length - scrollOffset, render those. Add scroll indicator.

- [ ] Implement windowed rendering (already mostly there; add overscan + empty-state).
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): windowed virtual message list (M2a)"

### Task 2: History search overlay (Ctrl+R)

**Files:** Modify `src/clients/tui-ink/app.tsx`

Add a history search modal: when Ctrl+R pressed, show an input that filters previous user prompts; Enter runs the selected one. Store prompt history in a ref array (append on submit).

- [ ] Add `history` ref array, append on submit.
- [ ] Add `historySearch` state (open/query/selected).
- [ ] Ctrl+R opens; typing filters; Enter/arrow navigate; Esc closes.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): history search overlay (M2a)"

### Task 3: Message selector + rewind UI

**Files:** Modify `src/clients/tui-ink/app.tsx`

Add an overlay listing messages; selecting one rewinds to that message's run. Reuse `rewindThread` from core/project/rewind.ts (already imported). Trigger via /rewind (already has picker) and via Ctrl+O or a command.

- [ ] Add message selector overlay (reuse picker pattern).
- [ ] Wire selection to rewindThread.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): message selector + rewind UI (M2a)"

### Task 4: Transcript toggle

**Files:** Modify `src/clients/tui-ink/app.tsx`

Add `/transcript` toggle (already shows transcript). Upgrade: toggle between full view and compact (hide tool messages). Add `transcriptExpanded` state.

- [ ] Add state + filter in render.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): transcript toggle (M2a)"

### Task 5: Cost/idle dialogs

**Files:** Modify `src/clients/tui-ink/app.tsx`

Add cost threshold dialog (when spent exceeds a threshold, show confirm) and idle dialog (when idle > N minutes, show resume). Simple: show a system message when threshold crossed.

- [ ] Implement threshold check after each turn.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): cost/idle dialogs (M2a)"

### Task 6: Focused dialog priority system

**Files:** Modify `src/clients/tui-ink/app.tsx`

Replace multiple simultaneous overlays with a single `focusedDialog` state and a priority order: message-selector > permission > prompt > cost > idle > onboarding > ... Only the highest-priority open dialog renders.

- [ ] Add `focusedDialog` state + priority comparator.
- [ ] Route picker/overlay rendering through it.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): focused dialog priority (M2a)"

---

## Self-Review
Spec coverage: M2a all items. M2b/c separate plans.

## Execution Handoff
Execute with subagent-driven-development. Task 1 first.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Created file successfully: docs/superpowers/plans/2026-10-26-ink-tui-m2a-quality.md