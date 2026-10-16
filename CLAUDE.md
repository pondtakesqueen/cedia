# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

cedia is a personal coding harness built as a **pi package** (extension + config) on `@earendil-works/pi-coding-agent` pinned to `1.3.0`, launched by `bin/cedia` (runs `pi` with `PI_CODING_AGENT_DIR=~/.cedia`). It is not a fork and has no CLI wrapper. `SPEC.md` holds every settled decision and the milestone order; read it before changing scope. No code exists yet; M0 is next.

## Rules that are easy to get wrong

- Build features as pi extension hooks (`agent_before_settle`, `tool_result`, `input`, `session_before_compact`, `before_agent_start`, `registerTool`, `registerVirtualModel`). Reach for a new layer only when a hook cannot do it, and record why in `SPEC.md`.
- Never add Claude.ai OAuth, Cursor login, or any request that impersonates another client (spoofed `claude-cli` User-Agent, `x-cursor-client-*` headers). Claude is API key only; ChatGPT uses pi-ai's `openai-chatgpt` provider, not `openai-codex`.
- Do not edit pstack's files. Cursor-specific names are translated by cedia (`Task`, `AskQuestion`, virtual models, `cedia-tools.md`).
- Items under "Deferred until evidence" in `SPEC.md` stay deferred until their trigger is measured on the smoke set.
- Never copy code or prompts from `research/src/claude-code` (no license) or leaked sources. Adapted Apache-2.0/MIT code needs a `NOTICE` entry.

## Research corpus

- `research/NOTES.md`: distilled findings with source paths. Update it when a new fact changes a decision.
- `research/mirror-docs.sh`: re-downloads official docs (Claude Code, Claude Platform, Codex, OpenAI API, xAI incl. Grok Build) as Markdown into `research/docs/` (gitignored). Grep there before searching the web.
- `research/src/` (gitignored, shallow clones): `codex`, `grok-build`, `oh-my-pi`, `cursor-plugins/pstack`, `claude-code` (read only). Re-clone with `git clone --depth 1` if missing.
- pi's own docs ship inside the npm package: `npm pack @earendil-works/pi-coding-agent@1.3.0` and read `package/docs/` (`extensions.md`, `sdk.md`, `rpc.md`, `compaction.md`, `virtual-models.md`, `packages.md`).
