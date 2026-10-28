# Changelog

## Unreleased
- `cedia daemon` yields to the desktop's daemon while it holds `~/.cedia/desktop.lock` (`daemon.desktop-lock`).
- `cedia threads send --image`: images on a thread message, shown with it at the next turn; a fork returns the forked run's images and `-p --image sha256:<hex>` shows a stored one again (`threads.send-images`).
- `cedia inline-edit`: a selection and an instruction, answered with the new text and its patch; nothing is written (`inline-edit`).

## 1.0.0
- Tier 1 complete: memory consolidation, managed settings tier (file-based), plugin marketplace (local), keybindings/vim/status line/doctor, background agents.
- Tier 2: Sleep, NotebookEdit, ToolSearch, Monitor, output styles, prompt suggestions.
- Deferrals documented in GAP_ANALYSIS_CC.md.
