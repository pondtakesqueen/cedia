# Permissions

cedia does not ask. A denied tool call returns a reason and the run continues. With the sandbox unavailable, the default mode is read-only. `--permission workspace` allows a write.

## Sub-features

- `perm-readonly` denies a bash redirect and leaves the work file absent.
- `perm-workspace` allows the same redirect when `--permission workspace` and `--sandbox off` are set.
- `perm-bad` rejects an unknown mode.

## How to get to it (user POV)

- Run `cedia -p "<prompt>"` with no `--permission` after doctor has reported `sandbox: unavailable`.
- Run the same prompt with `--permission workspace --sandbox off`.
- Run `cedia -p "<prompt>" --permission yolo` to see the mode check.

## Driving it with control-cedia

Preconditions:

- Launch and doctor have succeeded.
- Doctor reports `sandbox: unavailable`. If it reports `sandbox: available`, this read-only default no longer holds, and the read-only case below is the wrong journey. Stop and record that in Gotchas.
- The work directory has no `out.txt`.

```
cat > "$CEDIA_VERIFY_ROOT/script.json" << 'EOF'
[
  {"blocks":[{"type":"tool_use","id":"c1","name":"bash","input":{"command":"printf 'hi\\n' > out.txt"}}]},
  {"blocks":[{"type":"text","text":"Wrote note.txt."}]}
]
EOF
export CEDIA_FAUX_SCRIPT="$CEDIA_VERIFY_ROOT/script.json"
```

- **Read-only default.** Run `control-cedia run --name perm-ro -- -m faux -p "write it" --sandbox off`. Exit code `0`. Stderr contains `the sandbox is off, so this session is read-only`. Stdout is `Wrote note.txt.` Capture `test -f out.txt` with `control-cedia capture --name perm-ro-file -- test -f out.txt`. That capture exits `1`.
- **Workspace write.** Run `control-cedia run --name perm-ws -- -m faux -p "write it" --permission workspace --sandbox off`. Exit code `0`. Capture `cat out.txt`. Stdout is `hi` plus a newline.
- **Unknown mode.** Run `control-cedia run --name perm-bad -- -m faux -p "write it" --permission yolo --sandbox off`. Exit code `1`. Stderr contains `unknown permission mode`.

## Gotchas

- The read-only run exits 0. The model text says a file was written. The denial is in the session log as `"decision":"deny"` and `"rule":"mode:read-only"`, and the tool result text starts with `denied (mode:read-only):`. Observed 2026-10-21. Prove the mode by testing the file.
- The scripted final sentence in the seeding probe was `Wrote note.txt.` even when the command wrote `out.txt`. Trust `cat`, not that sentence.
- `--sandbox on` is a different failure, documented in `run-prompt.md`. Do not use it as a stand-in for the permission check.
- An allow rule can permit a single command inside read-only mode. This journey does not pass `--allow`. Adding one would make the read-only case pass for the wrong reason.
