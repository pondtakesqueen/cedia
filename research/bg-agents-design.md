# Background agents design (Tier 1 #6)

## Data shapes

Daemon:
- PID file: `~/.cedia/daemon.pid` (single PID).
- Socket/log dir: `~/.cedia/bg/`.

Background session record (append-only):
`~/.cedia/projects/<slug>/background.jsonl`
```
{ kind: 'start', id, thread, pid, startedAt, logPath }
{ kind: 'stop', id, at }
```

Commands: `agents`, `attach <id>`, `logs <id> [--tail N] [--follow]`, `stop|kill <id>`, `respawn <id|--all>`.

IPC: log file per session (tail -f style); liveness via pid check (process.kill(pid,0)).

## Resolution
- `--bg`: spawn detached `cedia -p --thread <id>` (or open thread), record session, print id.
- `agents`: list recorded sessions with liveness.
- `logs`: read tail of session log.
- `stop`: SIGTERM then SIGKILL after timeout.
- `respawn`: restart with current binary.
- `attach`: tail log and forward stdin (basic).
