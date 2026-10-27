# Ink TUI M2d — Deferred Quality Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Complete remaining cc-level quality items: settings tabs (Status/Config/Usage), permission router by tool type, vim depth (motions/text objects/find/counts/dot-repeat).

**Architecture:** React/ink + existing modules. Settings tabs as overlay. Permission router maps tool → dialog. Vim depth extends transitions.ts.

**Tech Stack:** Bun, React, ink, existing modules.

**Spec:** `docs/superpowers/specs/2026-10-26-ink-tui-design.md` (M2b/M2c deferred).

## Global Constraints

- `bun x tsc --noEmit` clean.
- `bun test test/tui-ink-boot.test.ts` green.
- Only `src/clients/tui-ink/*` and `src/clients/tui/vim/*` modified.
- No new runtime dependency.

---

### Task 1: Settings tabs overlay (Status/Config/Usage)

**Files:** Modify `src/clients/tui-ink/app.tsx`

Add `settingsTab` state ('status'|'config'|'usage'). /settings opens overlay with tabs. Tab/arrow switches tabs. Status tab: model/permission/thread/context/spend. Config tab: list settings keys (searchable). Usage tab: spend summary.

- [ ] Add state + overlay render.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): settings tabs overlay (M2d)"

### Task 2: Permission router by tool type

**Files:** Modify `src/clients/tui-ink/app.tsx`

Map tool name → dialog variant. Currently only bash/edit/webfetch/ask_user. Add Fallback for unknown tools. Ensure deny message shows rule.

- [ ] Add router function.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): permission router by tool type (M2d)"

### Task 3: Vim depth (motions, text objects, find, counts, dot-repeat)

**Files:** Modify `src/clients/tui/vim/transitions.ts` (+ motions.ts, textobjects.ts if needed)

Extend vim state machine: motions (w/b/e/0/$/gg/G), text objects (iw/aw/ip/ap), find (f/F/t/T), counts, dot-repeat. Update ink VimInput to use the extended transitions.

- [ ] Implement motions + text objects.
- [ ] Update VimInput to handle them.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): vim depth (motions/text objects/find/counts) (M2d)"

---

## Self-Review
Spec coverage: settings tabs, permission router, vim depth.

## Execution Handoff
Execute with subagent-driven-development. Task 1 first.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Created file successfully: docs/superpowers/plans/2026-10-26-ink-tui-m2d-deferred.md