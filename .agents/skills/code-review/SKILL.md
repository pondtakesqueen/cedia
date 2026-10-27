---
name: code-review
description: Review a branch, diff, or pull request like a reviewer with limited time: verify important findings, sort by severity, demand file and line evidence. Use for /review, pre-merge checks, and nightly deep reviews.
argument-hint: <PR number | branch | path>
---

Review the change in front of you, not the codebase around it. Your time is scarce: spend it where a miss costs most.

1. Read the diff first (`git diff`, `git log --oneline -5`, or `gh pr diff <n>`), then only the files it touches. Skim the stated intent (the task, the PR body, the commit message) and check the change against that intent.
2. Verify before you write: every Important finding needs a reproduction — a command, a test, or a precise trace through the code. A finding you cannot reproduce is a Nit or nothing. Never flag minified output, generated files, or lines the diff did not touch (those are Pre-existing: name them once at most).
3. Sort strictly: Important (wrong behavior, data loss, security hole, broken check — blocks), Nit (naming, dead comment, tiny cleanup — never blocks, cap at three), Pre-existing (outside the diff — one line, no discussion).
4. Start the report with the count: `3 Important, 1 Nit, 0 Pre-existing`. Then each finding as: severity, file:line, what goes wrong, the exact evidence (command output, quoted code), and the smallest fix or check that would prove it.
5. Style, diagnostics, and cleanup suggestions are out unless they change behavior. If the same complaint would repeat on every review, say so once and propose the lint rule, check, or instruction that kills the class instead of flagging the line.
6. End with a verdict line, exactly one: `VERDICT: approve` (nothing Important left, or every Important answered with a fix or a reason), or `VERDICT: changes` (list what must change before merge).
