# Ink TUI M4 — Verify full feature set in ink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Verify and polish the full feature set in the ink TUI: rewind (conversation+files), LSP diagnostics in edit results, full goal mode, classifier, spawn/delegate sub-threads. Ensure all core features that work in pi-tui also work and render in ink.

**Architecture:** React/ink + existing core modules. Most features are core-level and already wired via runHeadless; ink just renders results. This plan verifies rendering and adds any missing TUI surfaces.

**Tech Stack:** Bun, React, ink, existing modules.

**Spec:** `docs/history/ink-tui/specs/2026-10-26-ink-tui-design.md` (M2/M3) + SPEC.md stages 3-6.

## Global Constraints

- `bun x tsc --noEmit` clean.
- `bun test test/tui-ink-boot.test.ts` green.
- Only `src/clients/tui-ink/*` modified.
- No new runtime dependency.

---

### Task 1: Verify rewind renders correctly

**Files:** Modify `src/clients/tui-ink/app.tsx` (if needed)

Ensure /rewind and message selector rewind show rewoundText result and update thread/context. Already implemented. Verify by reading code; fix any missing context reset.

- [ ] Check /rewind case resets context to 0 after rewind (like pi-tui). Currently /rewind case calls rewindThread but doesn't reset context. Add `setContext(0)`.
- [ ] Typecheck + commit.

Commit: "fix(tui-ink): reset context after /rewind"

### Task 2: LSP diagnostics in edit results

**Files:** Modify `src/clients/tui-ink/app.tsx`

Ensure tool_result for edit/write shows LSP diagnostics if present in output. The output.text may contain diagnostics. Already rendered as tool_result (first line). Check if diagnostics are in output.text or a separate field. If separate, add rendering.

- [ ] Inspect SessionEvent tool_result shape for diagnostics field. If present, render them.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): render LSP diagnostics in edit results"

### Task 3: Goal mode full (--goal-mode full)

**Files:** Modify `src/clients/tui-ink/app.tsx`

Ensure /goal and --goal pass goalMode if set. Add `goalMode` state from args. Pass to runHeadless. Show acceptance criteria + strategist proposal in output (already in result.goal). Render them.

- [ ] Add goalMode state.
- [ ] Pass goalMode to runHeadless args.
- [ ] Render goal criteria/strategist in onDone (already renders goal verdict; add criteria if present).
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): full goal mode support"

### Task 4: Classifier integration (display)

**Files:** Modify `src/clients/tui-ink/app.tsx`

Classifier is core-level (--classifier). Ink renders permission deny messages. Ensure classifier BLOCK messages show the reason (already in permission deny handler). No code change needed; verify.

- [ ] Verify permission deny handler shows reason. Already does.
- [ ] Typecheck + commit (no-op if already correct).

Commit: "chore(tui-ink): verify classifier deny rendering"

### Task 5: Spawn/delegate sub-thread display

**Files:** Modify `src/clients/tui-ink/app.tsx`

/tasks and /agents already list sub-threads. Ensure they update after a turn (re-read store). Add refresh on /tasks.

- [ ] /tasks re-reads store (already does).
- [ ] Typecheck + commit (no-op if already correct).

Commit: "chore(tui-ink): verify sub-thread display"

---

## Self-Review
Spec coverage: M4 rewind/LSP/goal full/classifier/spawn.

## Execution Handoff
Execute with subagent-driven-development. Task 1 first.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Created file successfully: docs/history/ink-tui/plans/2026-10-26-ink-tui-m4-verify.md