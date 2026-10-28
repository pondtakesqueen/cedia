# Ink TUI M1 — Command Parity (part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Port the highest-value missing commands from pi-tui to ink: `/goal`, `/commit`, `/pr`, `/review`, `/plan`, `/quick`. Each ported command must behave like pi-tui's (same core calls, same confirm flow) and render in ink's message list.

**Architecture:** Each command is implemented as a case in `handleCommand` in `src/clients/tui-ink/app.tsx`, using the same core modules pi-tui uses (`core/project/commit.ts`, `core/trust/review.ts`, `core/roles.ts`, etc.). Confirm flows (y/n) reuse the existing `picker`/`push` pattern and a `pending` ref. No controller wiring yet (M0.5 Tasks 4-5 deferred).

**Tech Stack:** Bun, React, ink, existing core modules.

**Spec:** `docs/history/ink-tui/specs/2026-10-26-ink-tui-design.md` (M1 section).

## Global Constraints

- `bun run typecheck` (via `bun x tsc --noEmit`) clean.
- `bun test test/tui-ink-boot.test.ts` green.
- Only `src/clients/tui-ink/app.tsx` modified (plus imports).
- No new runtime dependency.

---

### Task 1: `/goal` command

**Files:** Modify `src/clients/tui-ink/app.tsx`

Port `/goal` (set condition, /goal off, show current). State: add `goal` state. Pass goal to runHeadless in submit (already? check). pi-tui passes `goal` in args. Ink currently doesn't pass goal. Add `goal` to args spread.

- [ ] Add `const [goal, setGoal] = useState<string | undefined>(args.goal);`
- [ ] Add case 'goal': parse condition; setGoal or clear; push confirmation.
- [ ] In submit, include `...(goal ? { goal } : {})` in runHeadless args.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): port /goal command"

### Task 2: `/commit` command

**Files:** Modify `src/clients/tui-ink/app.tsx`

Port pi-tui commit(): threadChanges → draftCommitMessage → confirm → commitFiles. Use pending ref for y/n confirmation. Add `pending` state (ref).

- [ ] Add `const pendingRef = useRef<{ what: string; yes: (signal: AbortSignal) => Promise<void> | void } | undefined>(undefined);`
- [ ] In submit, check pending first (y/n handling) like pi-tui.
- [ ] Add case 'commit': implement port.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): port /commit command"

### Task 3: `/pr` command

**Files:** Modify `src/clients/tui-ink/app.tsx`

Port pr(): prBlocked → confirm → pushAndOpenPr. Use pending ref.

- [ ] Add case 'pr'.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): port /pr command"

### Task 4: `/review` command

**Files:** Modify `src/clients/tui-ink/app.tsx`

Port review(): workingDiff or pullRequest → runPrompt with review role → parseVerdict → findings → pending confirm to send to writer.

- [ ] Add case 'review' with optional PR number.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): port /review command"

### Task 5: `/plan` and `/quick` commands

**Files:** Modify `src/clients/tui-ink/app.tsx`

Port plan/quick: set planWhen for next submit. Ink submit accepts planWhen? Currently submit takes text only. Add optional planWhen param to submit and pass to runHeadless.

- [ ] Add `planWhen` state or pass through. Modify submit signature: `submit(text, planWhen?)`.
- [ ] Add cases 'plan' and 'quick' that call submit with planWhen.
- [ ] Typecheck + commit.

Commit: "feat(tui-ink): port /plan and /quick commands"

---

## Self-Review
Spec coverage: M1 commands goal/commit/pr/review/plan/quick. Remaining M1 commands (memory, skills, mcp, palette, settings, doctor, resume, rename, branch, copy, tasks, agents, compact, fast, export, btw, theme, permission (has), vim, hooks, effort, statusline) deferred to M1b/c.

## Execution Handoff
Execute with subagent-driven-development. Task 1 first.<|end|><|start|>write to=assistant<|channel|>analysis<|message|>Created file successfully: docs/history/ink-tui/plans/2026-10-26-ink-tui-m1-commands.md