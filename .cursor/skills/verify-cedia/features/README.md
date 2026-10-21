# cedia verification map

This directory is the source for user-facing checks of cedia. Read it before driving the CLI, then follow one feature file.

## Baseline preconditions

- Launch with `eval "$(.cursor/skills/verify-cedia/scripts/control-cedia launch)"` from the repo root.
- Leave `CEDIA_VERIFY_ID`, `CEDIA_VERIFY_ROOT`, `CEDIA_VERIFY_WORK`, `CEDIA_HOME`, and `CEDIA_VERIFY_EVIDENCE` exported.
- Run `control-cedia doctor` and require `cedia: usage ok`, `drivable: faux`, and a home under `/tmp/cedia-verify-`.
- Pass `-m faux` with `CEDIA_FAUX_SCRIPT` pointed at a file outside the work directory. Do not drive `~/.cedia`.
- Pass `--permission workspace --sandbox off` when the journey needs a write and doctor reports `sandbox: unavailable`.
- Start each recipe from the baseline unless that recipe names another precondition.

## Driving conventions

- Treat every command as literal. Keep flags and quoted strings unchanged.
- Run cedia through `control-cedia run`. Run a follow-up read through `control-cedia capture`.
- Do not pass `--cwd`. The harness sets the work directory.
- Do not report a skipped entry point as verified through a different path.
- Leave proof files in `$CEDIA_VERIFY_EVIDENCE`. Cleanup removes the temp root only.

## Proof and skip reporting

- Capture the command and the resulting state.
- CLI proof is stdout, stderr, and the exit code stored next to the run.
- A write is proved by reading the file afterward, not by the model's last sentence.
- A faux proof includes a `--trace` file with no `AF_INET` and no `AF_INET6`.
- Record the feature file and the entry point with the artifact names.
- If a precondition is missing, stop that journey and write the failed command in that feature's Gotchas.

## Feature entry contract

Each feature file starts with an H1 and one paragraph. Then it uses these H2 headings, in order.

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with control-cedia`
4. `Gotchas`

## Features

- [Run a prompt](./run-prompt.md) covers `cedia -p`, the text receipt, the JSON result, and the declared check.
- [Threads](./threads.md) covers list, show, send, archive, and unarchive.
- [Lint a session](./lint-session.md) covers `cedia lint-session` on a real log.
- [Permissions](./permissions.md) covers read-only denial and a workspace write.
