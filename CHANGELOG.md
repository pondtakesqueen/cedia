# Changelog

## Unreleased
- Plugins load: Claude Code-layout plugins (`.claude-plugin/plugin.json`, `skills/`, `commands/`, `.mcp.json`) install from a folder, a git URL, `github:owner/repo` or `<plugin>@<marketplace>`; their skills and commands are skills named `<plugin>:<name>`; `cedia plugin show` lists what a plugin has and `cedia plugin mcp` adds its MCP servers; `update` installs from the same source again; hooks and agents are not run. `cedia marketplace update` is gone (a marketplace is read when a plugin installs).
- Removed: managed settings and MDM (`cedia mdm`, `policy-limits`, `settings --source managed|resolved|policy`, doctor's managed and mdm lines), since the permission policy never read them; `--bg`, `agents`, `logs`, `attach`, `stop`, `kill` and `respawn`, since queued threads and `cedia daemon` run work in the background; `serve`, `remote` and `teleport`, since the desktop does this work. `cedia settings` prints the user settings.
- Security: `cedia serve` listens on 127.0.0.1 only and answers only a request with its token (`CEDIA_SERVE_TOKEN`, or one printed at start; `cedia remote` sends `CEDIA_REMOTE_TOKEN`), and its runs keep the OS sandbox. Before, it took prompts in workspace mode with the sandbox off from anyone who could reach port 8787, a web page in the owner's browser included.
- Security: a plugin whose `name` is not one path segment is refused (`../x` had install delete a directory outside `~/.cedia/plugins`); the `team` tool takes only team ids of its own shape (`../settings` read and rewrote JSON files outside `~/.cedia/teams`, in read-only mode too).
- Prompt suggestions hold to the privacy level (under `zdr` nothing goes to a model that keeps prompts), and the TUI suggests from the last reply rather than from the word "success".
- `sleep` ends on a stop; `Monitor` output is clipped like bash's (the whole in a file) and a watch holds at most 4M characters.
- `cedia daemon` yields to the desktop's daemon while it holds `~/.cedia/desktop.lock` (`daemon.desktop-lock`).
- `cedia threads send --image`: images on a thread message, shown with it at the next turn; a fork returns the forked run's images and `-p --image sha256:<hex>` shows a stored one again (`threads.send-images`).
- `cedia context [--thread <id>] [--json]` and the TUI's `/context`: what fills a session's context now, by part: the system prompt, built-in tools and each MCP server's, AGENTS.md, memory, the skills list, and the history by kind, with the largest tool results and a bar of the window (`context`, `ContextBreakdown`).
- Away recap: `cedia threads recap <id> [--since <time|30m>] [--json]`, and in the TUI "while you were away" when turns end three minutes or more after you last touched the terminal (held until focus comes back when it reports blur): the runs and how each ended, files changed, checks, cost, todo, messages from other threads and an open question. Read from the logs, no model call (`threads.recap`, `AwayRecap`).
- `cedia inline-edit`: a selection and an instruction, answered with the new text and its patch; nothing is written (`inline-edit`).

## 1.0.0
- Tier 1 complete: memory consolidation, managed settings tier (file-based), plugin marketplace (local), keybindings/vim/status line/doctor, background agents.
- Tier 2: Sleep, NotebookEdit, ToolSearch, Monitor, output styles, prompt suggestions.
- Deferrals documented in docs/history/GAP_ANALYSIS_CC.md.
