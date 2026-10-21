# Threads

`cedia threads` lists the project's threads, shows one, leaves a user message, and archives or restores one. Every `cedia -p` run opens a thread under `$CEDIA_HOME/projects/<slug>/threads/`.

## Sub-features

- `threads-list` prints open threads, or `no threads in this project`.
- `threads-show` prints the task, sessions, result, and any message not yet delivered.
- `threads-send` appends a user message the thread will see on its next turn.
- `threads-archive` hides a thread from the default list.
- `threads-unarchive` puts it back.

## How to get to it (user POV)

- Run `cedia threads` or `cedia threads list` in a terminal whose `CEDIA_HOME` is the project home.
- Run `cedia threads show <id>`.
- Run `cedia threads send <id> <text>`.
- Run `cedia threads archive <id>` or `cedia threads unarchive <id>`.
- Add `cedia threads list --all` to include archived threads.

## Driving it with control-cedia

Preconditions:

- Launch and doctor have succeeded for this `CEDIA_VERIFY_ID`.
- One prompt run has finished, so a thread id exists. Take it from that run's stderr line `cedia thread: t-........`.
- `CEDIA_FAUX_SCRIPT` is a one-step text reply, so opening the thread does not write the work tree.

```
cat > "$CEDIA_VERIFY_ROOT/script.json" << 'EOF'
[{"blocks":[{"type":"text","text":"A done"}]}]
EOF
export CEDIA_FAUX_SCRIPT="$CEDIA_VERIFY_ROOT/script.json"
.cursor/skills/verify-cedia/scripts/control-cedia run --name thread-open -- -m faux -p "build the API" --permission workspace --sandbox off --output-format text
tid=$(sed -n 's/^cedia thread: \(t-[0-9a-f]\{8\}\).*/\1/p' "$CEDIA_VERIFY_EVIDENCE/thread-open.stderr")
```

- **List.** Run `control-cedia run --name thread-list -- threads`. Exit code `0`. Stdout contains the id, `done`, and `build the API`.
- **Show.** Run `control-cedia run --name thread-show -- threads show "$tid"`. Exit code `0`. Stdout contains the id, `done`, the task, `faux/scripted`, and `result:` then `A done`.
- **Send.** Run `control-cedia run --name thread-send -- threads send "$tid" "also log every request"`. Exit code `0`. Stdout is `sent to <id>`. Show the thread again. Stdout contains `(not seen yet)` and `also log every request`.
- **Archive.** Run `control-cedia run --name thread-archive -- threads archive "$tid"`. Exit code `0`. Stdout is `archived <id>`. A following `threads` list prints `no threads in this project`.
- **List archived.** Run `control-cedia run --name thread-all -- threads list --all`. Exit code `0`. Stdout contains `(archived)` and the id.
- **Unarchive.** Run `control-cedia run --name thread-unarchive -- threads unarchive "$tid"`. Exit code `0`. Stdout is `unarchived <id>`. The default list shows the id again.

## Gotchas

- `cedia threads show t-00000000` on a missing thread prints a Bun `ENOENT` stack for the thread jsonl path and exits 1. Observed 2026-10-21. `cedia threads show nope` prints `cedia: not a thread id: nope` and exits 1.
- `cedia threads send t-00000000 hi` prints `cedia: no thread t-00000000 in this project` and exits 1. Send and show do not share one missing-id message.
- Archiving removes the thread from the default list only. `threads list --all` still prints it. The word in the line is `(archived)`.
- A message stays `(not seen yet)` until a later `cedia -p --thread <id>` turn. This file does not resume the thread. That continuation is unverified in the seeding probes.
- The text of `threads send` is the remaining arguments joined by spaces. An argument that starts with `--` is parsed as a flag.
