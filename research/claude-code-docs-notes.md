# Notes from the Claude Code docs, for cedia (2026-10-23)

**Sources** (read 2026-10-22):

- the Agent SDK section, all 32 pages under https://code.claude.com/docs/en/agent-sdk/, including the TypeScript and Python references;
- https://code.claude.com/docs/en/whats-new and its 24 weekly digests (W13–W37);
- https://code.claude.com/docs/en/legal-and-compliance;
- https://code.claude.com/docs/en/cli-reference;
- the headless page, which the CLI reference points to;
- the harness blog post linked from the SDK overview.

Everything is paraphrased, and nothing is copied.

**Method:** four readers compared each page with SPEC.md, docs/ROADMAP.md, research/NOTES.md, the two other notes files, and cedia's code at `763c074`. Items cedia already has, or has already planned, are marked so they are not counted twice.

**Correction to NOTES.md:** Claude Code's cap of 200 subagents per session was removed in W32. Only the concurrency and depth limits remain.

## Top findings, ranked by expected impact

Each item says how it would be measured:

- **gate:** `bun evals/gate.ts`, or a vs-claude rerun;
- **test:** an offline test;
- **infra:** changes what can be measured, rather than a number.

### 1. The Claude Code plan and review step runs the reviewed repo's hooks outside cedia's sandbox (test)

`src/clients/headless/claude-code.ts` calls `claude -p` with these flags:

- `--output-format json`, `--model` and `--tools`;
- `--permission-mode dontAsk` and `--no-session-persistence`;
- `--allowedTools`.

It strips only API keys and `CEDIA_*` from the environment. It passes nothing that limits settings sources or MCP.

The headless page says that without bare mode, a `-p` run executes the project's `.claude/settings.json` hooks and connects its `.mcp.json`, even in an untrusted folder, without asking. It also loads the owner's whole `~/.claude`: global CLAUDE.md, SessionStart hooks, plugins, auto memory and claude.ai connectors. A repo under review can therefore run code outside the sandbox, which breaks SPEC's rule that a repository cannot run code outside the sandbox.

The fix is restricted mode: `--restricted` loads only managed settings and `--settings`, and returns Bash only when it is named in `--tools`. Pair it with `--strict-mcp-config` and `--disable-slash-commands`. Or use `--setting-sources` with an empty list together with `--strict-mcp-config`. Check that the subscription login still works under the chosen flags, since `--bare` ignores it. A test should show that a repo hook does not fire.

### 2. The `claude -p` eval arm measures the owner's setup, not Claude Code (gate: rerun vs-claude)

In `evals/run.ts`, the claude arm passes only `-p`, `--output-format json`, `--permission-mode acceptEdits` and `--allowedTools Bash`. It also inherits `process.env` in full. That has three consequences:

- **The owner's setup takes part.** The arm loads the owner's `~/.claude`, which has the pstack model config and a SessionStart hook. So the vs-claude arm D numbers include that setup.
- **The login can silently switch.** An `ANTHROPIC_API_KEY` in the shell moves the arm to API billing. `claude auth status` reports the auth method; check it once before a run.
- **The arms are not equal.**
  - cedia runs with `--max-budget-usd`, a turn cap and `--check <verify>`; Claude gets none of these.
  - The arm keeps no transcript.
  - Nothing confirms that no model fallback happened.

The fix:

- use `--safe-mode`, or `--setting-sources project,local --strict-mcp-config`;
- give the same `--max-budget-usd`, `--max-turns 200` and `--effort`;
- either tell Claude the verify command through `--append-system-prompt`, or record the asymmetry;
- read the per-model breakdown in the result to confirm no fallback;
- keep transcripts with `--session-id` (or stream-json);
- add `--exclude-dynamic-system-prompt-sections` for cache reuse across temp directories.

Then rerun vs-claude.

### 3. Put reminders on the tool result that caused them, not after "done" (gate: turns)

The SDK's PostToolUse `additionalContext`, PostToolBatch and Claude Code's diagnostics all attach the note to the call that triggered it.

In cedia, the slop guard and the done gate fire only after the final report (`loop/run.ts` around 595–604). In the vs-claude round, 54 of 216 Flash turns came after the first "done".

The change:

- When a declared check runs piped, add a note to that bash result saying it will not count.
- Put slop findings on the edit or write result that introduced them.

This is already planned in `claude-code-prompts-notes.md`; the docs confirm the mechanism. The modifying-system-prompts page adds one detail: a single sentence in the cached system prompt that explains what reminders are is cheaper than a prefix on every reminder.

### 4. Getting Flash to delegate (gate: spawn on/off)

Commit 875bbb1 has Flash spawning in 2 of 6 runs. The docs and the blog suggest five ways to make delegation easier for a weaker model:

- **Take the decision away from Flash.** In the harness blog, Claude writes a short workflow script and deterministic code runs the fan-out. For cedia, the Claude plan role or the coordinator would emit a JSON workflow: a list of briefs, each with kind, model, schema, verify command and dependencies. cedia runs it, and Flash never has to choose to spawn. This targets ROADMAP step 4 directly.
- **Batch fan-out.** A `spawn{tasks:[…]}` or `fanout{items, template, schema}` call is one decision instead of N.
- **A fork kind.** Fork subagents became the Claude Code default in W33: they inherit the conversation and its prompt cache. For cedia, the brief would shrink to one line, and DeepSeek's prefix cache would make the fork cheap. This is already planned in prompts-notes §3.
- **Background children.** Subagents have run in the background by default since W27, and the parent keeps working. This addresses ROADMAP step 4's open problem that work sub-threads run one at a time.
- **Named kinds** in settings (prompt, model, effort, maxTurns, read-only or write), like the SDK's AgentDefinition. A cheap model picks a named kind more readily than it writes a brief.

Every fan-out pattern needs a gate run against spawn off, with a budget cap. The blog's fan-outs used 0.5M–1.1M tokens.

### 5. Structured output for verdicts and child reports (gate: false-done, unclear verdicts)

- **Verdicts today:** review and goal verdicts are parsed from text lines (`core/trust/review.ts` around 43, `goal.ts` around 61). An unparsable answer becomes "unclear" or "not met".
- **Child reports today:** they come back as up to 4k of prose.
- **The SDK pattern:** a JSON Schema result, retried until it validates, ending in an `error_max_structured_output_retries` subtype. A success without the structured field is treated as a failure.

Changes:

- **For the Claude Code step:** request a verdict schema `{verdict, findings[{file, line, evidence}]}` with `--json-schema`.
- **For cedia itself:**
  - add `--output-schema <file>`, which gives a `structuredOutput` field on HeadlessResult;
  - add a `schema` field on `spawn` and `open_thread`;
  - use the API's structured outputs on Anthropic wires;
  - keep the line parser as the fallback for DeepSeek.

### 6. Edit deny rules don't cover other ways of writing (test)

On the permissions page, an `Edit(path)` rule covers every built-in tool that writes.

In cedia, `matches()` (`safety/policy.ts` around 92–94) returns false whenever the rule's tool name differs from the call's tool. So `deny: edit(x)` blocks neither `write x` (new) nor `bash sed -i x` (already noted in prompts-notes §5). The built-in secret and protected-path guards already apply to every tool; only user deny rules are affected.

The fix: apply `edit(...)` path rules to `write`, and to bash commands that write to that path.

### 7. Result fields that evals and the desktop need (infra)

These are modelled on the SDK's result and stream messages.

- **Per-model usage:** `modelUsage` with uncached, cache read and write, output, reasoning, cost and request count for each model ref. Today `costUsd` lumps together the writer, fallback, plan, review, advisor, classifier and sub-threads, and `Step` holds cost but no tokens. The four-arm comparison needs cost split by role and model.
- **Failure reasons:** `terminalReason` (quota, refusal, malformed, history_refused, hook, and so on), `errors[]` and `apiErrorStatus`, so evals can count failure modes. Today `error_during_execution` explains itself only in a string.
- **Denials:** `permissionDenials[{tool, callId, rule, reason}]`, folded from the permission events already logged.
- **An init event** with the resolved model, permission, sandbox, privacy, MCP status, skills, checks, profile, spawn mode and version, for reproducible runs and a simpler desktop status.
- **Sub-thread lifecycle events** (`subthread_started`, `subthread_progress`, `subthread_ended`) carrying tokens, tool uses, cost and the last tool. Evals could then measure parallel time, the open cost of work sub-threads.
- **More from the Claude Code step:** read its `modelUsage`, `usage`, `terminal_reason` and `permission_denials` into `Step`. Today it keeps only result, session id and cost.

### 8. Reproducible gate runs (infra)

`bin/cedia` reads `~/.cedia/settings.json`: roles, hooks, context, MCP, profiles and user skills. So gate results depend on the owner's settings, which is the same problem as finding 2 on cedia's own side. The SDK isolates a run with `settingSources: []`, and the CLI has `--bare` and `--safe-mode`.

The fix: an `--isolated` flag, or confirm that a `CEDIA_HOME` override covers everything, and use it in the gate. Add `--append-instructions` for prompt ablations without editing a profile, which the per-model delta work will need.

### 9. Sub-thread limits and effort (gate)

- **Turn cap with partial output:** a sub-thread that hits its turn cap should return its output marked partial, with a hint that it can be continued. Claude Code does this since W35, as does the SDK's per-agent `maxTurns`. Today a child gets the run's remaining turns (`clients/headless/main.ts` around 451). Cap explore at about 30 turns, so one stuck child cannot use up the run.
- **Effort per kind:** run explore at low effort where the model supports it. Today only the advisor and the classifier run at low (`main.ts` around 401 and 449).

### 10. Smaller items

- **Stream recovery:** in `-p` runs, a reply cut mid-stream is now continued when it has text and no tool calls (W35), and a 5-minute stream-idle watchdog aborts and retries (W27). Check that cedia's retry path does both.
- **Code-running configs:** `acceptEdits` now asks before writing build-tool configs that can run code (`.npmrc`, `.bazelrc`, `.pre-commit-config.yaml`), per W23. `.pre-commit-config.yaml` runs code the way `.git/hooks` does, so cedia's write guard should cover it.
- **Large MCP results:**
  - spill them to a file, as bash already does with `ctx.spill`, instead of cutting the middle with `clip` (`mcp/tools.ts` around 61);
  - honour a tool's `_meta["anthropic/maxResultSizeChars"]` (W14).
- **Fallback chain:** `--fallback` takes one model; Claude Code takes a chain of up to three (W24).
- **Thread messages:** mail from `message_thread` and background notices should say they carry no owner authority. Claude Code made this change in W24 and W28.
- **Changing directory:** Claude Code's `/cd` (W24) moves a session to another directory without rebuilding the cache, by sending the new directory's instructions as a message. cedia could do the same when a thread changes worktree.
- **Read-before-edit:** newer models may Write without reading first, and Edit counts a file seen through grep, cat or sed as read (W14, W23, W33). Relaxing cedia's read-before-edit rule is a candidate, measured on the gate.
- **Reviewer backends and evals:**
  - `claude ultrareview --json --timeout` runs non-interactively and exits 0 or 1 (W18). It could be a cloud reviewer backend, but never under `zdr`.
  - `claude plugin eval` (W37) reports per-case deltas and cost with and without a plugin. The gate could report spawn on and off in the same shape.
- **Bug carried over from turns-analysis:** `real()` in `safety/policy.ts` (around 123–134) still calls `realpathSync` without a try, as of `763c074`.

## Already in cedia (no change needed)

- **Done and stopping:**
  - the done gate, slop guard, stop hooks and goal judge go further than the SDK's "the reply had no tool calls";
  - a max-turns default of 200;
  - a run-wide budget that includes sub-threads, with calls refused once it is spent;
  - the result subtypes, and refusal treated as an error.
- **Calls and checkpoints:**
  - a bounded parallel pool for read-only calls;
  - shadow-git snapshots, which also track bash changes. The SDK's checkpointing does not track bash.
- **Sessions:**
  - resume, fork and rewind through `--thread`, `threads fork` and rewind;
  - `undo`;
  - cold resume;
  - stream-json events;
  - `threads send` for messages mid-run.
- **Cache and cost:**
  - the cache rules (per-session values in the first user turn, mid-session changes appended);
  - cache-miss attribution and the usage report.
- **Permissions and safety:**
  - fail-closed hooks that re-check the policy after rewriting input;
  - read-only sub-threads with write tools stripped;
  - spawn count and concurrency caps;
  - inert sub-thread reports;
  - sandbox-runtime with a scrubbed environment and egress proxy;
  - a repo cannot set hooks, roles or MCP.
- **Asking and loading:**
  - skills loaded by name first and their body on demand;
  - `ask_user` with options;
  - `asked` ending a run.

## Skipped

- **SessionStore mirroring:** cedia is for one user, with local logs.
- **General OpenTelemetry export:** SPEC chooses no telemetry. Capturing arm D's raw requests (`OTEL_LOG_RAW_API_BODIES=file:<dir>`) only during evals would be acceptable.
- **Changing the model mid-session:** it conflicts with the cache rules.
- **The TypeScript V2 session API:** it has been removed.
- **Tool search for built-in tools:** it pays off only past about 10 tools or about 10% of the context. It remains an option for MCP-heavy setups (SPEC cache rule 3).

## Legal and compliance (what the page says; not legal advice)

What the page says:

- **Terms:** Pro and Max use falls under the Consumer Terms. Team, Enterprise and API use falls under the Commercial Terms.
- **Login:** OAuth sign-in is for subscribers using Claude Code and other native Anthropic apps in the ordinary way. Developers building products, including on the Agent SDK, should use API keys.
- **Third parties may not:**
  - offer claude.ai login;
  - route requests through Free, Pro or Max credentials on behalf of their users;
  - collect, store or intermediate claude.ai credentials or session tokens.
- **Allowed:** the page explicitly allows an end user to sign in to the unmodified Claude Code binary with their own subscription. Plan limits assume ordinary, individual use.

Assessment:

- **The plan and review steps look fine.** One person runs the unmodified `claude` binary with their own login, and cedia never reads, stores or sends a token. That matches the allowance.
- **The `claude -p` eval arm needs care.** Many parallel scripted runs may not count as ordinary, individual use, and the page does not define the term. Running that arm on a Console API key avoids the question and makes its cost figures billable rather than notional.
- **Keep it this way:** cedia must never save a `claude setup-token` token.
- **If cedia is ever offered to other people,** the commercial conditions apply:
  - the Commercial Terms;
  - an unmodified binary with its sign-in intact;
  - each user on their own credentials;
  - no reselling or intermediating;
  - no Claude Code name or logo in the product's name.
- **Training-data use:** the page does not cover it. SPEC's caveat about "Help improve Claude" stays the guide.
