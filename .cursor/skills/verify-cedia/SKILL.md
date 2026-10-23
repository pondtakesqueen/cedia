---
name: verify-cedia
description: Use when proving cedia, the headless Bun CLI coding harness, by launching an isolated run, driving a user command, and keeping the evidence. Reach for it before claiming a cedia CLI change works.
---

# Verify cedia

cedia is a CLI. A user runs `bin/cedia` from this repo. With no prompt, when stdin and stdout are both terminals, `src/cli.ts` starts the TUI in `src/clients/tui/main.ts`. This skill drives headless runs. A run with no prompt and no terminal prints usage and exits 2.

Drive cedia with `.cursor/skills/verify-cedia/scripts/control-cedia`. The script finds the repo from its own path. Each launch creates an empty work directory and an empty `CEDIA_HOME` under `/tmp/cedia-verify-<id>`. Two launches can run side by side because the ids differ. Never point a run at `~/.cedia`.

When `ANTHROPIC_API_KEY`, `CEDIA_ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`, and `DEEPSEEK_API_KEY` are unset, use `-m faux` and `CEDIA_FAUX_SCRIPT`. That stand-in is the model provider boundary in `providerFor`. Bash, files, the session log, the thread store, and the done gate still run.

Read `features/README.md` before choosing a journey.

## Launch

Bun has to be on `PATH`. `.github/workflows/ci.yml` pins Bun 1.4.2. If `bun` is missing, install that version, then run `bun install --frozen-lockfile` from the repo root.

From the repo root:

```
eval "$(.cursor/skills/verify-cedia/scripts/control-cedia launch)"
```

Ready means both of these, checked by launch itself.

- `bin/cedia -h` exits 0 and its first line is `usage: cedia [options]                 the TUI, at a terminal: each prompt is a turn of one thread`.
- `cedia threads` against the empty home prints `no threads in this project` and exits 0.

Launch writes `launch.help.txt` and `launch.threads.txt` under `$CEDIA_VERIFY_EVIDENCE`, then prints `export` assignments. `eval` of that output exports them for later commands.

```
CEDIA_VERIFY_ID
CEDIA_VERIFY_ROOT
CEDIA_VERIFY_WORK
CEDIA_HOME
CEDIA_VERIFY_EVIDENCE
```

There is no server. Each drive is one foreground `control-cedia run`.

## Doctor

```
.cursor/skills/verify-cedia/scripts/control-cedia doctor
```

Doctor does not pass `-p` and does not create a thread. It prints the Bun version, `cedia: usage ok`, the home and work paths, the current threads line, whether `bwrap` and `socat` are installed, and whether `ANTHROPIC_API_KEY`, `CEDIA_ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`, and `DEEPSEEK_API_KEY` are set. It does not print secret values. The report is also `$CEDIA_VERIFY_EVIDENCE/doctor.txt`.

Exit 0 means a faux drive can start. `sandbox: unavailable` is still exit 0. Pass `--sandbox off` on that drive. `--sandbox on` stays unverified until both `bwrap` and `socat` are installed.

## Drive

`control-cedia run` executes `bin/cedia` with this run's `CEDIA_HOME`. For a prompt and for `threads`, it appends `--cwd` set to the work directory. For `lint-session` it does not append `--cwd`, because that subcommand treats every argument as a log path. Do not pass `--cwd` yourself.

```
.cursor/skills/verify-cedia/scripts/control-cedia run --name <label> -- <cedia args>
```

Add `--trace` before `--` when you need the network observation. The trace is `$CEDIA_VERIFY_EVIDENCE/<label>.strace` and records `connect`, `sendto`, and `sendmsg`. `strace` has to be on `PATH`.

`control-cedia capture` runs a command with the work directory as its cwd and the same `CEDIA_HOME`.

```
.cursor/skills/verify-cedia/scripts/control-cedia capture --name <label> -- <command> [args]
```

Both commands store `<label>.stdout`, `<label>.stderr`, and `<label>.exit`. They print stdout and stderr as the command runs. Their exit code is the command's exit code.

A faux script is a JSON array of reply steps. Put it outside the work directory.

```
{"blocks":[{"type":"text","text":"Wrote note.txt."}]}
{"blocks":[{"type":"tool_use","id":"c1","name":"bash","input":{"command":"printf 'verify-ok\\n' > note.txt"}}]}
```

Tool names in a script are `read`, `edit`, `write`, and `bash`. Export the file before `run`.

```
export CEDIA_FAUX_SCRIPT="$CEDIA_VERIFY_ROOT/script.json"
```

Pass `-m faux`. The default model is `deepseek`, which calls a provider.

## Evidence

Keep proof in `.cursor/skills/verify-cedia/artifacts/<id>/`. That directory is gitignored. Cleanup does not delete it.

Record the command, stdout, stderr, and exit code. Also read the side effect the user was promised. For a prompt that writes a file, `cat` the file and run `cedia threads show <id>`. The model's sentence is not the proof. A read-only session can print `Wrote note.txt.` and exit 0 while the file is absent.

Faux skips the provider network. A traced `bin/cedia -m faux` run on 2026-10-21, with `CEDIA_FAUX_KEY` unset, produced no `connect`, `sendto`, or `sendmsg` syscalls. The session log contained `"wire":"faux"` and no `http` URL. That same run still executed bash, wrote the work file, wrote the session log and the thread file, and ran the declared `--check`. `costUsd` in `--output-format json` is computed from the faux price table. It is not a bill. When you drive a faux journey, pass `--trace` and confirm the trace has no `AF_INET` and no `AF_INET6`. A trace that contains either one is not an offline faux proof.

These journeys stay unverified without keys or a sandbox.

- Any model alias other than `faux`, including the default `deepseek`.
- `--plan` and `--review`, including a `claude-code:<model>` role.
- Quota fallback onto Haiku.
- `--sandbox on`. With `bwrap` and `socat` missing, that command exits 1 and prints `cedia: sandbox unavailable: bubblewrap (bwrap) not installed; socat not installed`.

## Cleanup

```
.cursor/skills/verify-cedia/scripts/control-cedia cleanup
```

Cleanup deletes `/tmp/cedia-verify-$CEDIA_VERIFY_ID` and nothing else. Runs are foreground, so cleanup does not search the process table and does not kill by name. If you background a run, kill that pid yourself. After cleanup, the evidence directory must still exist. `cleanup` exits 2 if it does not.

## Cedian

Cross-repo checks read cedian from the sibling directory of this checkout. The directory name is `cedian`. When this repo is `/workspace`, that path is `/cedian`.

`.cursor/install.sh` clones `https://github.com/pongsathonkheereekaew/cedian.git` into that directory. `.cursor/environment.json` lists `github.com/pongsathonkheereekaew/cedian` in `repositoryDependencies`. That entry adds cedian to the GitHub token for the environment. The entry does not clone the repo.

If the sibling directory has no `.git` directory, say the checkout is missing. Skip the cross-repo check. A failed clone does not fail install.

## Helpers

Script path: `.cursor/skills/verify-cedia/scripts/control-cedia`.

```
eval "$(.cursor/skills/verify-cedia/scripts/control-cedia launch)"
.cursor/skills/verify-cedia/scripts/control-cedia doctor
.cursor/skills/verify-cedia/scripts/control-cedia run --name <label> [--trace] -- <cedia args>
.cursor/skills/verify-cedia/scripts/control-cedia capture --name <label> -- <command> [args]
.cursor/skills/verify-cedia/scripts/control-cedia cleanup
```
