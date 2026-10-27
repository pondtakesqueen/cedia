# Ink TUI Design

Status: draft, pending user review.
Date: 2026-10-26.
Scope: replace the default pi-tui with an Ink (React) TUI that reaches Claude Code parity, keeping pi-tui as a fallback.

## 1. Goal

Make `cedia` with no prompt at a terminal run an Ink-based TUI by default that is
feature- and quality-equivalent to the existing pi-tui and to Claude Code's TUI
(see `../../history/CLONE_SPEC.md` §16). The pi-tui stays reachable via `--tui pi` until the
Ink TUI passes the full test suite and one full day of real use.

## 2. Non-goals (v1)

- Voice, buddy, computer-use (deferred per SPEC Tier 2).
- Plugin marketplace, remote/cloud sessions, bridge (Tier 3).
- Surveys, desktop upsell, ultraplan choice dialogs (ultraplan ships as
  `/plan`; the choice dialog is deferred).
- PowerShell tool (no tool in cedia), NotebookEdit tool (Tier 2, deferred).
- Rewriting the core loop, tools, or providers. Both TUIs share them.

## 3. Constraints and findings

- `ink-markdown` is CJS and does `require('ink')`, which Bun does not support
  because `ink` is ESM. It cannot be used as-is. Markdown rendering will use
  `marked` + `marked-terminal` through dynamic `import()`, or a custom renderer.
- `ink` 8.x, `ink-text-input` 6.x, `ink-spinner`, `ink-markdown` are already in
  `package.json`. No new dependency is required for M0–M2.
- The core path is identical for both TUIs: each prompt is one `runHeadless`
  call streamed as `stream-json`. The TUI differs only in rendering and input.
- `src/clients/tui/main.ts` currently mixes controller logic (thread store,
  command dispatch, submit, abort) with pi-tui rendering. That coupling is the
  main risk of duplication.

## 4. Architecture

### 4.1 Shared controller

Extract a framework-agnostic controller from `src/clients/tui/main.ts` into
`src/clients/tui/controller.ts` (new) exposing:

- `state`: thread id, model, permission, goal, running, activity, messages (a
  plain array of `{ role, text, status }`), spent, context, vimMode, scrollOffset.
- `actions`: `submit(text)`, `command(line)`, `abort()`, `quit()`,
  `applyModel(ref)`, `restore(mode, force)`, etc.
- `events`: a small callback surface (`onMessage`, `onState`, `onActivity`,
  `onDone`) so each renderer subscribes.

The controller owns: ThreadStore, snapshots, undo/rewind/fork, command dispatch,
headless invocation, stream-json decoding, session event handling. It does not
import pi-tui or ink.

Both `src/clients/tui/main.ts` (pi-tui view) and `src/clients/tui-ink/app.tsx`
(ink view) become thin views over the controller. This is M0.5 and is a
prerequisite for M1, because otherwise every command is implemented twice.

### 4.2 View layer (ink)

`src/clients/tui-ink/app.tsx` becomes a React component tree:

- `<App>`: layout, global input (useInput), scrollback.
- `<MessageList>`: virtualized-ish list (last N messages), markdown for
  assistant, tool cards, permission/deny lines.
- `<StatusBar>`: model, permission, thread, idle/working, context, spend, vim mode.
- `<InputBox>`: `VimInput` (reuse `vim/transitions.ts` via a React wrapper).
- `<Picker>` / `<Overlay>`: command palette, model/permission pickers, transcript.
- `<PermissionDialog>`: bash/edit/webfetch/ask_user.
- `<Onboarding>` / `<Doctor>`: separate screens.

### 4.3 Markdown

A new module `src/clients/tui-ink/markdown.tsx` exports a `<Markdown text>`
component. Implementation: dynamic `import('marked')` and
`import('marked-terminal')`, set options, parse to an ANSI string, render inside
`<Text>`. Code blocks keep monospace styling via marked-terminal's renderer.
Fallback: plain `<Text>` if parsing fails.

### 4.4 Input and keybindings

Reuse `src/clients/tui/keybindings/*` and `vim/transitions.ts`. Ink's `useInput`
dispatches to the resolver; chord timeout 1000ms. Global handlers: Ctrl+C (quit),
Esc (abort/normal mode), PageUp/PageDown (scroll), Tab (accept suggestion).

### 4.5 Mouse and selection

Ink receives raw stdin (already done in the current app). Mouse tracking escape
sequences (`\x1b[?1000h`) enable click/drag selection with copy to clipboard.
Keep the existing implementation but move selection state into the controller or
a view-local hook.

## 5. Milestones

### M0 — Boot (blocker fix)
Done when: `cedia --tui ink` (at a TTY) starts, shows a prompt, accepts input,
streams a reply, shows a status line, and Esc/Ctrl+C aborts cleanly. No crash.
Verification: manual smoke + a new `test/tui-ink-boot.test.ts` (if feasible under
Bun's test runner with a fake stdin) or a documented manual checklist.

### M0.5 — Shared controller extraction
Done when: `src/clients/tui/controller.ts` exists and both `main.ts` and
`tui-ink/app.tsx` use it; `bun test test/tui.test.ts` still passes; no
behavior change in pi-tui.
Verification: typecheck + tui.test.ts.

### M1 — Core REPL quality
Port the full command set and quality rendering:
- Markdown, tool cards, permission dialogs (bash/edit/webfetch/ask_user), deny
  display.
- Vim input mode: reuse `vim/transitions.ts` as-is (operators d/c/y, counts).
  Full motions/text objects/find/dot-repeat are deferred to M2b.
- All commands listed in COMMANDS (pi-tui), including commit/pr/review/goal.
- Thread store, undo/redo/rewind/fork, model picker.
- Scrollback via slicing (render last N messages).
Done when: `test/tui.test.ts`-equivalent scenarios pass against ink (a new
`test/tui-ink.test.ts` mirroring the pi-tui suite), and a manual day of use.

### M2a — Virtual list, history search, dialogs
- VirtualMessageList-style windowed rendering (replace slicing).
- History search (Ctrl+R) over prompt history.
- Message selector overlay + rewind UI (select a message, rewind to it).
- Transcript toggle (collapse/expand).
- Cost/idle dialogs (spend threshold, idle return).
- Focused dialog priority system (`getFocusedInputDialog`) routing overlapping
  dialogs (permission, cost, idle, onboarding, model-switch, lsp-recommendation,
  plugin-hint).
Done when: manual checklist + smoke tests pass.

### M2b — Settings, permission router, vim depth
- Settings tabs: Status / Config / Usage, with search mode in Config.
- Permission router by tool type: Bash, FileEdit, FileWrite, WebFetch, Skill,
  AskUserQuestion, Enter/ExitPlanMode, Filesystem, Sed, Fallback (PowerShell and
  NotebookEdit deferred).
- Vim motions, text objects, find, counts, dot-repeat (full `src/vim/*`).
- Status line command (`settings.statusLine`) + `StatusLineCommandInput`.
- Keybindings file + contexts + chords.
- Overlays: palette, model/permission pickers, settings, message actions.
- Mouse selection + copy, resize, alt-screen, pause/resume.
Done when: `GAP_ANALYSIS_CC.md` §A items 1–7 marked done for ink.

### M2c — Onboarding, doctor, resume, accessibility
- Onboarding/trust dialog flow (port `onboarding.ts` verbatim first).
- Doctor screen (versions, settings errors, keybinding warnings, MCP warnings,
  sandbox info).
- Resume conversation picker.
- Accessibility: `--ax-screen-reader` flat text mode (no borders/animations).
Done when: manual checklist passes and onboarding completes end-to-end.

### M3 — Switch default
- `--tui` default becomes `ink`; `--tui pi` remains.
- Update README, SPEC, AGENTS, command help.
- Keep pi-tui code (no deletion) for one release.
Done when: full test suite green, gate run (`bun evals/gate.ts`) not regressed
(no TUI change affects the gate, but verify), and one full day of real use.

## 6. Testing strategy

- Unit-test the controller (framework-agnostic) with a fake terminal, mirroring
  `test/tui.test.ts`. This is the primary regression net and does not require
  React rendering.
- Ink component rendering is tested only via smoke imports (`test/tui-wire.test.ts`
  pattern) and manual runs, because Bun's test runner and Ink's reconciler are
  not a good fit for full render tests. If feasible, add `ink-testing-library`.
- Every milestone ends with `bun test` (all files) green and `bun run typecheck`
  clean.

## 7. Risks

- Ink + Bun ESM interop may have more blockers beyond ink-markdown; M0 probes this.
- Performance of Yoga layout on large scrollback; mitigate with throttled render
  and virtualization (render last N messages, like the current app).
- Controller extraction touches the most-tested file (`main.ts`); do it in one
  focused M0.5 PR with no behavior change, verified by the existing tests.

## 8. Decisions (resolved)

1. Testing: controller-only for v1 (no `ink-testing-library`). Component smoke
   via `test/tui-wire.test.ts` pattern + manual runs.
2. Onboarding/trust: port `onboarding.ts` verbatim first (M2c), polish later.
3. Vim scope: M1 = current `transitions.ts` (d/c/y + counts); M2b = full
   motions/text objects/find/dot-repeat.
4. Virtualization: M1 = slicing (last N); M2a = true windowed virtual list.
5. Deferred explicitly: surveys, desktop upsell, ultraplan choice dialogs,
   PowerShell/NotebookEdit tools, voice/buddy/computer-use, plugin marketplace,
   remote/cloud/bridge.

## 9. Approval

Pending user review of this spec before writing the implementation plan.