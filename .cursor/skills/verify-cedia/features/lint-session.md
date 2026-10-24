# Lint a session

`cedia lint-session` reads one or more session logs and prints trust findings. A clean log prints nothing and exits 0.

## Sub-features

- `lint-clean` accepts the log written by a finished `cedia -p` run.
- `lint-usage` rejects a call with no file.

## How to get to it (user POV)

- Finish a `cedia -p` run.
- Find the log at `$CEDIA_HOME/sessions/<project-slug>/<session-id>.jsonl`. The slug drops one leading slash from the project directory and turns every run of characters outside letters, digits, `.`, `_`, and `-` into a single `-`. When `git rev-parse --git-common-dir` prints a path whose last part is `.git`, the project directory is the parent of that path. A subdirectory and a linked worktree then share the main worktree's slug. Outside git, and in a bare repository, the project directory is the working directory. The verify work directory is not a git checkout, so its slug is that path.
- Run `cedia lint-session <file.jsonl>`.

## Driving it with control-cedia

Preconditions:

- Launch and doctor have succeeded.
- A prompt run has written a session log. The run-prompt journey does this. If you start from an empty home, open one thread first with the text script in `threads.md`.

- **Find the log.**

```
.cursor/skills/verify-cedia/scripts/control-cedia capture --name session-path -- find "$CEDIA_HOME/sessions" -name '*.jsonl'
```

  Exit code `0`. Stdout is one absolute `*.jsonl` path per line. A second `cedia -p` adds another line.

- **Lint it.** Pass each path as its own argument.

```
mapfile -t logs < "$CEDIA_VERIFY_EVIDENCE/session-path.stdout"
.cursor/skills/verify-cedia/scripts/control-cedia run --name lint -- lint-session "${logs[@]}"
```

  Exit code `0`. Stdout and stderr are empty. Quoting the whole find output as one argument makes `lint-session` look up a path that contains a newline. That call throws a Bun stack from `SessionLog.load` and exits 1.

- **Usage.** Run `control-cedia run --name lint-usage -- lint-session`. Exit code `2`. Stderr is `usage: cedia lint-session <file.jsonl>...`.

## Gotchas

- A path that does not exist makes `lint-session` throw a Bun stack from `SessionLog.load` and exit 1. Observed 2026-10-21 with a missing jsonl path. The command does not print the usage line in that case.
- Findings, when they exist, use `<file>:<line>: <rule>: <message>` on stdout and the process exits 1. A clean log is empty output, not a success sentence.
- Lint reads the file you pass. It does not look up `CEDIA_HOME` for you.
- A prompt started in a subdirectory of a git repo files its log under the main worktree's slug. Observed 2026-10-23. The working directory was `<repo>/main/nested` and the session directory name ended in `repo-check-main`. A linked worktree does the same. Observed 2026-10-24. The worktree was `slug-wt` beside `slug-repo`, and the session directory name ended in `slug-repo`. A bare repository filed its log under its own directory. That session directory name ended in `slug-bare.git`.
