# Run a prompt

`cedia -p` sends one prompt, runs the tools the scripted model asks for, and prints the final text. A declared `--check` has to pass after the last write or the process exits 1.

## Sub-features

- `run-text` prints the final text on stdout and a receipt on stderr.
- `run-json` prints one JSON result that includes `evidence.changed` and `thread`.
- `run-check` fails the run when the model claims success without running the declared check after the write.

## How to get to it (user POV)

- Run `cedia -p "<prompt>"` in a terminal. The prompt can also be piped on stdin when `-p` is omitted.
- Add `-m faux` with `CEDIA_FAUX_SCRIPT` when no provider key is available.
- Add `--permission workspace --sandbox off` when doctor says the sandbox is unavailable and the prompt must write.
- Add `--check "<command>"` for the done gate.
- Add `--output-format json` when you want the result object instead of the text.

## Driving it with control-cedia

Preconditions:

- Launch and doctor have succeeded for this `CEDIA_VERIFY_ID`.
- The work directory has no `note.txt`.
- Doctor reports `drivable: faux`.

- **Write the script.** Save the model steps outside the work directory.

```
cat > "$CEDIA_VERIFY_ROOT/script.json" << 'EOF'
[
  {"blocks":[{"type":"tool_use","id":"c1","name":"bash","input":{"command":"printf 'verify-ok\\n' > note.txt"}}]},
  {"blocks":[{"type":"tool_use","id":"c2","name":"bash","input":{"command":"grep -q verify-ok note.txt"}}]},
  {"blocks":[{"type":"text","text":"Wrote note.txt."}]}
]
EOF
export CEDIA_FAUX_SCRIPT="$CEDIA_VERIFY_ROOT/script.json"
```

- **Text entry.** Run the prompt the way a user does, with the default text format.

```
.cursor/skills/verify-cedia/scripts/control-cedia run --name prompt --trace -- -m faux -p "write note.txt that says verify-ok" --permission workspace --sandbox off --check "grep -q verify-ok note.txt"
```

  Exit code `0`. Stdout is `Wrote note.txt.` plus a newline. Stderr contains `cedia receipt: changed note.txt; checks grep -q verify-ok note.txt (exit 0); unverified none` and a line `cedia thread: t-` followed by 8 hex characters.

- **Read the file.** Confirm the write from the work directory.

```
.cursor/skills/verify-cedia/scripts/control-cedia capture --name note -- cat note.txt
```

  Exit code `0`. Stdout is `verify-ok` plus a newline.

- **Read the thread.** Take the id from the stderr line.

```
tid=$(sed -n 's/^cedia thread: \(t-[0-9a-f]\{8\}\).*/\1/p' "$CEDIA_VERIFY_EVIDENCE/prompt.stderr")
.cursor/skills/verify-cedia/scripts/control-cedia run --name thread-show -- threads show "$tid"
```

  Exit code `0`. Stdout contains the id, `done`, the task `write note.txt that says verify-ok`, and `result:` followed by `Wrote note.txt.`

- **Read the session log.** Lint the log the run just wrote.

```
.cursor/skills/verify-cedia/scripts/control-cedia capture --name session-path -- find "$CEDIA_HOME/sessions" -name '*.jsonl'
log=$(cat "$CEDIA_VERIFY_EVIDENCE/session-path.stdout")
.cursor/skills/verify-cedia/scripts/control-cedia run --name lint -- lint-session "$log"
.cursor/skills/verify-cedia/scripts/control-cedia capture --name wire -- grep -o '"wire":"[^"]*"' "$log"
```

  `lint` exits `0` with empty stdout. `wire` stdout is `"wire":"faux"` on every match.

- **Confirm the provider was not contacted.** Inspect the trace from `--trace`.

```
.cursor/skills/verify-cedia/scripts/control-cedia capture --name trace-net -- grep -E 'AF_INET|AF_INET6|connect\(|sendto\(|sendmsg\(' "$CEDIA_VERIFY_EVIDENCE/prompt.strace"
```

  Exit code `1` and empty stdout. The trace recorded no `connect`, `sendto`, or `sendmsg`.

- **JSON entry.** The script file stays on disk. A second process reads it again. Remove `note.txt`, then run the same prompt with JSON output.

```
rm -f "$CEDIA_VERIFY_WORK/note.txt"
.cursor/skills/verify-cedia/scripts/control-cedia run --name prompt-json -- -m faux -p "write note.txt that says verify-ok" --permission workspace --sandbox off --check "grep -q verify-ok note.txt" --output-format json
```

  Exit code `0`. Stdout is one JSON object whose `subtype` is `success`, whose `evidence.changed` contains `note.txt`, and whose `evidence.unverified` is empty. Stderr is empty. `note.txt` is `verify-ok` again.

## Gotchas

- Default `cedia -p` with no `--permission` and no working sandbox prints `cedia: sandbox unavailable (bubblewrap (bwrap) not installed; socat not installed); bash runs unsandboxed. Use --sandbox on to require it.` and `cedia: the sandbox is off, so this session is read-only. Use --permission workspace to allow writes without it.` The process can still exit 0 and print `Wrote note.txt.` when the bash call was denied. The file is absent. Observed 2026-10-21 with `-m faux` and no permission flag.
- `--sandbox on` on this machine exits 1 with `cedia: sandbox unavailable: bubblewrap (bwrap) not installed; socat not installed`. That mode is unverified here.
- The receipt line is text mode only. `--output-format json` puts `evidence` on stdout and leaves stderr empty when `--permission` and `--sandbox` are explicit.
- `costUsd` on a faux JSON result is a price-table number. The trace above had no network syscalls.
- Live aliases, `--plan`, `--review`, and quota fallback are unverified. No provider key was set during the seeding run.
- `cedia threads show` is a separate `control-cedia run`. It does not take `-p`.
