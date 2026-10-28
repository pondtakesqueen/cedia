# Ink TUI M2c — Quality (onboarding, accessibility) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Complete M2 cc-level quality: onboarding/trust dialog flow (port verbatim), accessibility mode (--ax-screen-reader), resume conversation picker.

**Architecture:** React/ink. Port pi-tui onboarding.ts (already imported in app.tsx). Add screen reader flat-text mode. Add resume picker overlay.

**Tech Stack:** Bun, React, ink, existing modules.

**Spec:** `docs/history/ink-tui/specs/2026-10-26-ink-tui-design.md` (M2c section).

## Global Constraints

- `bun x tsc --noEmit` clean.
- `bun test test/tui-ink-boot.test.ts` green.
- Only `src/clients/tui-ink/*` modified.
- No new runtime dependency.

---

### Task 1: Onboarding/trust dialog flow

**Files:** Modify `src/clients/tui-ink/app.tsx`

Port pi-tui onboarding: on start, if !isComplete(), show pending steps. /onboarding command already exists. Add trust dialog prompt on first run: if !hasTrustDialogAccepted, show trust message and accept on 'y'.

- [ ] Add useEffect on mount: if !isComplete(), push system message listing pending steps.
- [ ] Add trust prompt: if !hasTrustDialogAccepted, push trust dialog message; handle 'y' via pending or a simple flag.
- [ ] /onboarding accept → acceptTrust().
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): onboarding/trust dialog flow (M2c)"

### Task 2: Accessibility mode (--ax-screen-reader)

**Files:** Modify `src/clients/tui-ink/app.tsx`

When CEDIA_SCREEN_READER=1 or --ax-screen-reader flag, render flat text (no borders, no spinners, no markdown styling). Gate decorative elements behind `!screenReader`.

- [ ] Add `const screenReader = useIsScreenReaderEnabled() || process.env.CEDIA_SCREEN_READER === '1';` (already computed).
- [ ] Gate borders/spinners/markdown behind !screenReader.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): accessibility screen-reader mode (M2c)"

### Task 3: Resume conversation picker

**Files:** Modify `src/clients/tui-ink/app.tsx`

/resume already lists threads. Add a picker overlay when /resume with no arg: show thread list, select to resume. Reuse picker pattern.

- [ ] /resume with no arg opens picker with thread list.
- [ ] On select, setThread.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): resume conversation picker (M2c)"

---

## Self-Review
Spec coverage: M2c onboarding, accessibility, resume picker. Settings tabs, permission router, vim depth deferred.

## Execution Handoff
Execute with subagent-driven-development. Task 1 first.