# Lint a session

`cedia lint-session` reads one or more session logs and prints trust findings. A clean log prints nothing and exits 0.

## Sub-features

- `lint-clean` accepts the log written by a finished `cedia -p` run.
- `lint-usage` rejects a call with no file.

## How to get to it (user POV)

- Finish a `cedia -p` run.
- Find the log at `$CEDIA_HOME/sessions/<project-slug>/<session-id>.jsonl`. The slug is the work directory path with the leading slash removed and other separators turned into `-`.
- Run `cedia lint-session <file.jsonl>`.

## Driving it with control-cedia

Preconditions:

- Launch and doctor have succeeded.
- A prompt run has written a session log. The run-prompt journey does this. If you start from an empty home, open one thread first with the text script in `threads.md`.

- **Find the log.**

```
.cursor/skills/verify-cedia/scripts/control-cedia capture --name session-path -- find "$CEDIA_HOME/sessions" -name '*.jsonl'
log=$(cat "$CEDIA_VERIFY_EVIDENCE/session-path.stdout")
```

  Exit code `0`. Stdout is one absolute `*.jsonl` path.

- **Lint it.**

```
.cursor/skills/verify-cedia/scripts/control-cedia run --name lint -- lint-session "$log"
```

  Exit code `0`. Stdout and stderr are empty.

- **Usage.** Run `control-cedia run --name lint-usage -- lint-session`. Exit code `2`. Stderr is `usage: cedia lint-session <file.jsonl>...`.

## Gotchas

- A path that does not exist makes `lint-session` throw a Bun stack from `SessionLog.load` and exit 1. Observed 2026-10-21 with a missing jsonl path. The command does not print the usage line in that case.
- Findings, when they exist, use `<file>:<line>: <rule>: <message>` on stdout and the process exits 1. A clean log is empty output, not a success sentence.
- Lint reads the file you pass. It does not look up `CEDIA_HOME` for you.
