# Clean-room audit (2026-10-28)

The owner asked for every reference to the leaked Claude Code source to be removed and the repository audited for anything taken from it (AGENTS.md: never copy code or prompts from leaked sources).

## Removed

- `docs/history/CLONE_SPEC.md`: a spec written from the leaked TypeScript snapshot (82 `[SRC:path]` citations of leaked files) and from reverse engineering the `claude` binary. Deleted.
- `docs/history/IMPLEMENTATION_PLAN.md`: a plan that named the leaked tree's local path as evidence, proposed the leak's own file layout (`src/main.tsx`, `src/QueryEngine.ts`) and black-box study with REA. Deleted.
- References to both in `GAP_ANALYSIS_CC.md`, `docs/TUI_AUDIT.md` and `docs/superpowers/specs/2026-10-26-ink-tui-design.md` now point to the public-docs notes (`research/claude-code-docs-notes.md`).

Both files stay in git history; this repository is public, so removing them from history would need a rewrite of `main` and a force push, which is the owner's call.

## Checked

- `src/` keeps cedia's own layout (`cli.ts`, `core/`, `clients/`, `protocol/`); nothing follows the leak's layout.
- Searched `src/` for leak-only identifiers (`tengu`, ant-only flags, `USER_TYPE`, Statsig/GrowthBook keys): none.
- Read the model-facing prompts of the features most likely drawn from the leak (`core/project/consolidate.ts`, `core/memory/extract.ts`, `core/project/magicdocs.ts`): written in cedia's own words, in its style.
- Prompt research (`research/claude-code-prompts-notes.md`) cites Piebald-AI's extracted prompts and is paraphrased by its own rule; `research/NOTES.md` already excludes the leaked source.

## Still to decide

- Two commits credit the leak in their messages: `a40cd21` (the root commit, "learnings from cc leak") and `f1906d0` ("learnings from opencode+cc leak": draft stash, frecency, diff rendering, keybindings, external editor). The code in `f1906d0` (frecency ranking, draft stash) is generic and reads as written here, but its idea came from the leak.
- Three features carry names known only from the leak: AutoDream (`autoDream`, `cedia memory consolidate`), extractMemories (`cedia memory extract`) and MagicDocs (the `# MAGIC DOC:` header). Their code is cedia's, but the names and the header format are taken from it; renaming them is a small change.
- This audit compares against public sources and cedia's own history only; it does not open the leak to diff against it, since that would break the rule it checks.
