# CLONE_SPEC.md — Claude Code CLI (clean-room clone specification)

> **Purpose**: Specification for a clean-room reimplementation of the Claude Code
> CLI. Written from evidence only — leaked TypeScript source snapshot
> (`claude-code-source-code-leak-main`, ~1,902 files, 512k+ LOC, snapshot dated
> 2026-03-31) plus black-box observation of the installed binary
> `claude` 2.1.304 (`/opt/homebrew/bin/claude`). No code or assets are copied;
> an implementer is expected to write new code from this spec.
>
> **Authoritative evidence legend**
> - `[SRC:path]` — leaked source file.
> - `[BIN:flag]` / `[BIN:cmd]` — observed in `claude --help` (v2.1.304).
> - `[UNK]` — unconfirmed / unknown.
>
> **Clean-room rules**: Do not import/copy code or assets from Anthropic's
> Claude Code (no license) or leaked sources. Adapted third-party
> Apache-2.0/MIT code requires a `NOTICE` entry. Use REA
> (`https://github.com/morluto/rea`) to study the installed `claude` binary as a
> black box for the current version where the leak is stale.
>
> **Scope**: User-visible features, screens, state machines, inputs/outputs, edge
> cases, file formats, network protocols, settings/persistence, error behaviors.
> Internal/private flags and ant-only features are noted but may be omitted from
> a minimal clone.

---

## 1. Product overview

Claude Code is an interactive + non-interactive CLI agent for software
engineering tasks. It runs in a terminal, edits files, runs commands, searches
codebases, manages MCP servers, and coordinates multi-agent workflows. It
supports Anthropic first-party API, AWS Bedrock, Google Vertex, and Azure
Foundry. Runtime: Bun/Node, terminal UI via React + Ink.

Key modes:
- Interactive REPL (default when TTY).
- Non-interactive print mode (`-p/--print`).
- SDK/stream-json mode for programmatic clients.
- Remote control / bridge mode.
- Background agents (`--bg`).
- Cloud sessions.

---

## 2. Invocation & CLI surface

### 2.1 Entrypoint flow `[SRC:src/entrypoints/cli.tsx]`, `[SRC:src/main.tsx]`

1. Fast paths (zero imports): `--version/-v`, `--dump-system-prompt`,
   `--claude-in-chrome-mcp`, `--chrome-native-host`, `--computer-use-mcp`,
   `--daemon-worker`, bridge/remote-control, daemon, bg sessions (ps/logs/attach/kill),
   templates, environment-runner, self-hosted-runner, tmux+worktree.
2. Sets `CLAUDE_CODE_SIMPLE=1` for `--bare`.
3. Dynamically imports `src/main.tsx` (`cliMain`/`run()`).
4. `preAction` hook: `ensureMdmSettingsLoaded()`, `ensureKeychainPrefetchCompleted()`,
   `init()`, sinks, migrations, `loadRemoteManagedSettings()`, `loadPolicyLimits()`.
5. Validate flags; resolve worktree/teammate/sdk/teleport/remote; validate session ID;
   download `--file` resources.
6. `initBuiltinPlugins()`/`initBundledSkills()`; `setup()`; resolve model/agents/MCP/tools.
7. If non-interactive (`-p`): apply config env, telemetry, connect MCP, `runHeadless()`
   `[SRC:src/cli/print.ts]`.
8. If interactive: setup screens, LSP init, prefetches, then continue/resume/teleport/remote/assistant
   or `launchRepl()` `[SRC:src/replLauncher.tsx]`.

### 2.2 Top-level options `[BIN]` (v2.1.304, superset of leaked)

Core/session: `[prompt]`, `-p/--print`, `--bare`, `--output-format`, `--input-format`,
`--json-schema`, `--include-hook-events`, `--include-partial-messages`,
`--replay-user-messages`, `--autocompact`, `--max-budget-usd`, `--max-turns`,
`--max-thinking-tokens`, `--thinking`, `--effort` (low,medium,high,xhigh,max),
`--model`, `--fallback-model`, `--agent`, `--agents`, `--betas`, `--workload`,
`--session-id`, `-n/--name`, `--system-prompt/--system-prompt-file`,
`--append-system-prompt/--append-system-prompt-file`, `--system-prompt-snapshot`,
`-c/--continue`, `-r/--resume`, `--fork-session`, `--no-session-persistence`,
`--resume-session-at`, `--rewind-files`, `--from-pr`, `--teleport`, `--file`,
`--add-dir`, `--ide`.

Permissions/sandbox: `--permission-mode` (acceptEdits,auto,bypassPermissions,manual,dontAsk,plan),
`--permission-prompts` (host/none), `--allowedTools/--allowed-tools`,
`--disallowedTools/--disallowed-tools`, `--tools`, `--allow-dangerously-skip-permissions`,
`--dangerously-skip-permissions`, `--restricted`, `--safe-mode`.

MCP/plugins: `--mcp-config`, `--strict-mcp-config`, `--plugin-dir`, `--plugin-url`,
`--disable-slash-commands`.

Worktree: `-w/--worktree`, `--tmux`.

Chrome/remote: `--chrome/--no-chrome`, `--remote-control`, `--remote-control-session-name-prefix`,
`--bg/--background`, `--cloud`, `--environment`, `--remote`.

Debug: `-d/--debug`, `--debug-file`, `--debug-to-stderr`, `--verbose`, `-v/--version`, `-h/--help`.

Feature-gated/other: `--advisor`, `--brief`, `--ax-screen-reader`, `--exclude-dynamic-system-prompt-sections`,
`--forward-subagent-text`, `--prompt-suggestions`, `--teleport`, `--restricted`,
`--safe-mode`, `--system-prompt-snapshot`, `--no-chrome`.

Ant/teammate identity (leaked `[SRC:src/main.tsx]`): `--agent-id`, `--agent-name`,
`--team-name`, `--agent-color`, `--plan-mode-required`, `--parent-session-id`,
`--teammate-mode`, `--agent-type`, `--sdk-url`, `--messaging-socket-path`,
`--channels`, `--dangerously-load-development-channels`, `--proactive`, `--assistant`,
`--tasks`, `--agent-teams`, `--enable-auto-mode`, `--advisor`, `--hard-fail`,
`--init/--init-only/--maintenance`, `--advisor`.

### 2.3 Subcommands `[BIN]`, `[SRC:src/main.tsx]`

`agents`, `attach <id|name>`, `auth`, `auto-mode`, `doctor`, `gateway`, `import`,
`install`, `logs <id>`, `mcp`, `plugin|plugins`, `purge`, `respawn`, `rm <id>`,
`setup-token`, `stop|kill <id>`, `ultrareview`, `update|upgrade`.

Ant-only (leaked): `up`, `rollback`, `log`, `error`, `export`, `task`.

Feature-gated: `remote-control/rc`, `assistant`, `auto-mode`.

`mcp` subcommands: serve, remove, list, get, add, add-json, add-from-claude-desktop,
reset-project-choices, plus `mcp add`, XAA idp. `[SRC:src/cli/handlers/mcp.ts]`.

`plugin` subcommands: validate, list, install, uninstall, enable, disable, update;
`marketplace`: add, list, remove, update. `[SRC:src/cli/handlers/plugins.ts]`.

### 2.4 Slash commands (in-session) `[SRC:src/commands.ts]`

`COMMANDS` aggregates built-ins + feature-gated modules (`proactive`, `brief`,
`assistant`, `bridge`, `voice`, `workflows`, `ultraplan`, `buddy`, `peers`, `fork`,
`torch`, etc.) and `INTERNAL_ONLY_COMMANDS` for ant builds. `getCommands(cwd)`
merges bundled/builtin/plugin/workflow/skill commands, filters by availability +
enabled, injects dynamic skills. Key built-ins observed in TUI `[SPEC of cedia]`:
`/diff`, `/undo`, `/redo`, `/commit`, `/pr`, `/review`, `/new`, `/thread`, `/model`,
`/goal`, `/help`, `/quit`, plus `/vim`, `/memory`, `/compact`, `/context`, `/cost`,
`/doctor`, `/config`, `/permissions`, `/hooks`, `/mcp`, `/plugin`, `/agents`,
`/tasks`, `/resume`, `/rename`, `/export`, `/share`, `/clear`, `/color`, `/theme`,
`/effort`, `/fast`, `/output-style`, `/passes`, `/privacy-settings`, `/release-notes`,
`/sandbox-toggle`, `/status`, `/stats`, `/tag`, `/terminalSetup`, `/thinkback`,
`/context`, `/ctx_viz`, `/files`, `/copy`, `/branch`, `/rewind`, etc.

`REMOTE_SAFE_COMMANDS`, `BRIDGE_SAFE_COMMANDS`, `isBridgeSafeCommand`,
`filterCommandsForRemoteMode`.

---

## 3. Architecture

### 3.1 Layering `[SRC:src/query.ts,QueryEngine.ts,context.ts]`

```
src/
  cli.ts / main.tsx          # entrypoint, commander
  entrypoints/               # cli.tsx, init.ts, mcp.ts, sdk/
  commands.ts / commands/    # slash commands
  tools.ts / tools/          # tool registry + implementations
  Tool.ts                    # tool types
  query/                     # agent loop
  QueryEngine.ts
  context.ts / context/      # system/user context
  bootstrap/                 # global session state
  coordinator/               # coordinator mode
  tasks/                     # task system
  screens/                   # REPL, Doctor, ResumeConversation
  components/                # UI
  state/                     # AppState store
  ink/                       # terminal renderer
  keybindings/ vim/ voice/
  services/                  # api, mcp, lsp, compact, memory, oauth, plugins, ...
  utils/                     # settings, permissions, sandbox, git, model, ...
  hooks/                     # React hooks
  memdir/                    # auto-memory
  migrations/
  plugins/ skills/
  remote/ server/
  types/ schemas/
```

Rule: `src/core`-equivalent (here `services`+`utils`) must not import from
clients; UI in `screens`/`components`/`ink`.

### 3.2 Agent loop `[SRC:src/query.ts]`

`query()`/`queryLoop()` async generator. One `while(true)` = one model API turn.
State: messages, toolUseContext, autoCompactTracking, recovery counts, turnCount,
pendingToolUseSummary, transition reason.

Per-iteration:
1. Tool-result budget enforcement (`applyToolResultBudget`).
2. Snip compact (`snipCompactIfNeeded`).
3. Microcompact (`deps.microcompact`).
4. Context collapse (`contextCollapse.applyCollapsesIfNeeded`).
5. Autocompact (`deps.autocompact`).
6. Streaming API call (`deps.callModel`).
7. Tool execution.
8. Recovery: PTL/collapse drain/reactive compact/max-output-tokens.
9. Stop hooks.
10. Next iteration or terminal.

`QueryEngine` `[SRC:src/QueryEngine.ts]`: owns session state (`mutableMessages`,
usage, file cache, permission denials). `submitMessage()` runs `processUserInput`,
persists transcript, then streams `query()`, dispatching assistant/user/progress/
attachment/stream_event/system/tool_use_summary; records transcripts; enforces
`maxBudgetUsd`/structured-output retries; yields SDK `result`
(success/error_max_turns/error_max_budget_usd/error_during_execution).

### 3.3 Streaming tool execution `[SRC:src/services/tools/StreamingToolExecutor.ts]`

Tools added as `tool_use` blocks arrive during streaming. Concurrency-safe tools
run in parallel; buffers results in arrival order; yields progress immediately.
Sibling-error cancellation (Bash errors abort siblings); user interrupt behavior.

Tool orchestration `[SRC:src/services/tools/toolOrchestration.ts]`: partitions calls
into batches (consecutive concurrency-safe vs single non-safe); read-only batches
concurrent (`runToolsConcurrently`, max concurrency env `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`);
non-safe serial; applies context modifiers.

### 3.4 Context building `[SRC:src/context.ts]`

- `getSystemContext()`: git status snapshot, injection; memoized.
- `getUserContext()`: CLAUDE.md via `getClaudeMds`/`getMemoryFiles`, currentDate; memoized.
- Coordinator user context merged in `QueryEngine`.
- `bootstrap/state.ts`: global session state (cwd, model, cost, usage, session id,
  flags, invoked skills).

---

## 4. State management

`[SRC:src/state/store.ts, AppStateStore.ts, AppState.tsx]`
- Minimal external store: `createStore<T>(initialState, onChange?)` →
  `{getState, setState(updater), subscribe}`. `setState` skips no-op via
  `Object.is`, fires onChange then listeners.
- `AppState` (DeepImmutable + non-immutable fields: tasks, agentNameRegistry,
  mcp, plugins). `getDefaultAppState()`.
- `AppStateProvider` (React) creates store, injects Mailbox/Voice providers;
  `useAppState(selector)` via `useSyncExternalStore`, `useSetAppState`.
- Applies settings changes; disables bypass permissions on mount.

---

## 5. Tools

### 5.1 Registry `[SRC:src/tools.ts]`

- `getAllBaseTools()` exhaustive list (feature/flag gated).
- `getTools(permissionContext)`: simple mode (`CLAUDE_CODE_SIMPLE`), REPL hiding
  of `REPL_ONLY_TOOLS`, `isEnabled()`, deny rules.
- `assembleToolPool(permissionContext, mcpTools)`: built-ins + MCP, deny-filtered,
  deduped by name (built-ins win), sorted for prompt-cache stability.
- `filterToolsByDenyRules()` strips blanket-denied tools.

### 5.2 Built-in tools (name → purpose; key params)

Filesystem/shell `[SRC:src/tools/...]`:
- **Bash**: `command`, `timeout`, `description`, `run_in_background`,
  `dangerouslyDisableSandbox`.
- **PowerShell**: same core params.
- **Read** (FileReadTool): `file_path`, `offset`, `limit`, `pages` (PDF).
- **Write** (FileWriteTool): `file_path`, `content`.
- **Edit** (FileEditTool): `file_path`, `old_string`, `new_string`, `replace_all`.
- **Glob**: `pattern`, `path`.
- **Grep**: `pattern`, `path`, `glob`, `output_mode`, context (`-B/-A/-C`, `context`),
  `-n`, `-i`, `type`, `head_limit`, `offset`, `multiline`.
- **NotebookEdit**: `notebook_path`, `cell_id`, `new_source`, `cell_type`, `edit_mode`.

Web:
- **WebFetch**: `url`, `prompt`.
- **WebSearch**: `query`, `allowed_domains`, `blocked_domains`.

Agents/tasks:
- **Agent**: `description`, `prompt`, `subagent_type`, `model`, `run_in_background`,
  `name`, `team_name`, `mode`, `isolation`, `cwd`.
- **Skill**: `skill`, `args`.
- **TaskOutput**: `task_id`, `block`, `timeout`.
- **TaskStop**: `task_id`/`shell_id`.
- **TodoWrite**: `todos`.
- **TaskCreate/TaskGet/TaskUpdate/TaskList** (Todo v2).
- **TeamCreate**: `team_name`, `description`, `agent_type`.
- **TeamDelete**: (no params).
- **SendMessage**: `to`, `summary`, `message`.

Plan/worktree:
- **EnterPlanMode**: (no params).
- **ExitPlanMode**: `allowedPrompts`.
- **EnterWorktree**: `name`.
- **ExitWorktree**: `action`, `discard_changes`.

Scheduling/remote:
- **CronCreate**: `cron`, `prompt`, `recurring`, `durable`.
- **CronDelete**: `id`.
- **CronList**: (no params).
- **RemoteTrigger**: `action`, `trigger_id`, `body`.

MCP:
- **MCPTool** (name `mcp`): passthrough input.
- **McpAuthTool**: dynamic name `buildMcpToolName(server,'authenticate')`; no params.
- **ListMcpResourcesTool**: `server`.
- **ReadMcpResourceTool**: `server`, `uri`.

Config/UX/dev:
- **Config** (ant-only): `setting`, `value`.
- **AskUserQuestion**: `questions`, `answers`, `annotations`, `metadata`.
- **SendUserMessage** (BriefTool; legacy `Brief`): `message`, `attachments`, `status`.
- **LSP**: `operation`, `filePath`, `line`, `character` (gated `ENABLE_LSP_TOOL`).
- **ToolSearch**: `query`, `max_results`.
- **SyntheticOutput** (StructuredOutput): passthrough.
- **TestingPermission** (test env only).

Feature-gated/absent in leak: Sleep, REPL (ant), Monitor, SendUserFile,
PushNotification, SubscribePR, OverflowTest, CtxInspect, TerminalCapture,
WebBrowser, Snip, ListPeers, Workflow, VerifyPlanExecution, Tungsten,
SuggestBackgroundPR. `hasEmbeddedSearchTools()` can omit Glob/Grep.

### 5.3 Tool permissions `[SRC:src/Tool.ts, tools.ts]`

- `ToolPermissionContext`: mode, allow/deny/ask rules by source, working dirs,
  bypass/auto flags.
- `filterToolsByDenyRules()` strips blanket-denied tools before model exposure.
- Each tool implements `checkPermissions(input, context)` and `isReadOnly()`;
  defaults in `buildTool`.

### 5.4 Tool search `[SRC:src/tools/ToolSearchTool, utils/toolSearch.ts]`

- `ToolSearchTool` discovers deferred tools via keyword or `select:<name>`.
- Auto-enables based on MCP/deferred tool token share (`ENABLE_TOOL_SEARCH`,
  auto:N); defers tools with `defer_loading`.
- `isToolSearchEnabledOptimistic()` gates inclusion.

---

## 6. Permission system

Modes `[SRC:src/main.tsx, utils/permissions]`: `acceptEdits`, `auto`,
`bypassPermissions`, `manual`, `dontAsk`, `plan`. (Leaked names: acceptEdits/
bypassPermissions/dontAsk/plan/auto/manual.)

Rules: allow/deny/ask by source (user/project/local/flag/policy/cli). Deny rules
can target tool name or `Tool(pattern)`. Permission prompts via
`--permission-prompt-tool` or host. Auto mode uses classifier `[UNK: classifier
prompt details]`.

Sandbox `[SRC:src/utils/sandbox]`: `@anthropic-ai/sandbox-runtime` (bubblewrap
Linux, sandbox-exec macOS). Writes only cwd + temp; reads blocked for credential
stores; network only registries + allowed domains. `--sandbox auto/on/off`.
Bash never inherits keys/tokens/`CEDIA_*` env (analogous).

Trust dialog `[SRC:src/components/TrustDialog/TrustDialog.tsx]`: workspace trust
confirmation; warns about bash/hooks/MCP/API helpers/env vars; accepts or exits;
saves `hasTrustDialogAccepted`. Skipped in non-interactive `-p`.

---

## 7. Settings & configuration

### 7.1 Setting sources `[SRC:src/utils/settings/constants.ts]`

Low→high: `userSettings`, `projectSettings`, `localSettings`, `flagSettings`,
`policySettings`.

Paths:
- user: `~/.claude/settings.json` (or `cowork_settings.json` in cowork mode).
- project: `<cwd>/.claude/settings.json`.
- local: `<cwd>/.claude/settings.local.json`.
- flag: `--settings` path.
- policy (managed):
  - macOS: `/Library/Application Support/ClaudeCode`
  - Windows: `C:\Program Files\ClaudeCode`
  - Linux: `/etc/claude-code`
  - Files: `managed-settings.json` + `managed-settings.d/*.json` (merged alphabetically).
  - MDM: HKLM/plist (admin) and HKCU (user-writable).
  - Remote: `~/.claude/remote-settings.json`.
- Policy resolution: remote > MDM(plist/HKLM) > managed files > HKCU (first wins).

Plugin settings act as lowest-priority base. Atomic writes via
`updateSettingsForSource`. Migrations in `src/migrations/`.

### 7.2 Global config `[SRC:src/utils/config.ts, env.ts]`

- Config home: `CLAUDE_CONFIG_DIR` or `~/.claude`.
- Global config file: `~/.claude.json` (legacy `~/.claude/.config.json`).
  Stores `projects`, `mcpServers`, tips history, `autoCompactEnabled`, etc.

### 7.3 Environment variables (selected) `[SRC:src/main.tsx]`

Anthropic/auth: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_BETAS`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`,
`CLAUDE_CODE_SKIP_*_AUTH`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`.

Mode/entrypoint: `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_REMOTE`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_PROACTIVE`, `CLAUDE_CODE_BRIEF`,
`CLAUDE_CODE_COORDINATOR_MODE`, `CLAUDE_CODE_SAFE_MODE`.

Session: `CLAUDE_CODE_TASK_LIST_ID`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN`,
`CLAUDE_CODE_REMOTE_SESSION_ID`, `CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES`,
`CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, `CLAUDE_CODE_DISABLE_SESSION_DATA_UPLOAD`.

Debug/infra: `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `MAX_THINKING_TOKENS`,
`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_DISABLE_AUTOUPDATER`,
`CLAUDE_CODE_ABLATION_BASELINE`, `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`,
`API_TIMEOUT_MS`, `DISABLE_PROMPT_CACHING*`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT`.

---

## 8. Persistence layout

`[SRC:src/utils/sessionStorage.ts, sessionStoragePortable.ts, envUtils.ts]`

Base: `~/.claude` (override `CLAUDE_CONFIG_DIR`).

- Global config: `~/.claude.json`.
- Credentials: macOS Keychain → fallback `~/.claude/.credentials.json` (mode 0600)
  `[SRC:src/utils/secureStorage/*, auth.ts]`.
- Memory (auto): `~/.claude/projects/<sanitized-git-root>/memory/` (override
  `CLAUDE_CODE_REMOTE_MEMORY_DIR` / `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` /
  settings `autoMemoryDirectory`) `[SRC:src/memdir/paths.ts]`.
- Sessions/transcripts: `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`,
  agent transcripts `agent-<id>.jsonl`, `.meta.json`.
- Session memory: `~/.claude/projects/<sanitized-cwd>/<sessionId>/session-memory/summary.md`.
- Policy limits cache: `~/.claude/policy-limits.json`.
- Remote managed settings cache: `~/.claude/remote-settings.json`.
- Plugins: `~/.claude/plugins` (or `cowork_plugins`), override
  `CLAUDE_CODE_PLUGIN_CACHE_DIR`; seed dirs `CLAUDE_CODE_PLUGIN_SEED_DIR`;
  `installed_plugins.json`, `known_marketplaces.json`, cache, data dirs.
- Teams: `~/.claude/teams`.
- Cache (logs/errors/mcp logs): env-paths `claude-cli` cache.
- Upstreamproxy (CCR): CA bundle `~/.ccr/ca-bundle.crt`, token
  `/run/ccr/session_token`.

Session file format: JSONL, first line `session` event `{cwd, parentSession?, thread?,
role, createdAt}`. Leaf = last event; fork = new file whose first event's
`parentId` points into source. `[SRC:src/utils/sessionStorage.ts]` `[UNK: exact
event schema beyond this]`.

---

## 9. Network protocols

### 9.1 Provider client `[SRC:src/services/api/client.ts]`

`getAnthropicClient()` builds Anthropic SDK client:
- Branches: Bedrock (`AnthropicBedrock`), Foundry (`AnthropicFoundry`),
  Vertex (`AnthropicVertex`), first-party (`Anthropic`).
- Timeout `API_TIMEOUT_MS` default 600s; proxy fetch; default headers:
  `x-app`, `User-Agent`, `X-Claude-Code-Session-Id`, custom headers,
  container/remote IDs, client app, additional protection.
- `buildFetch` injects `x-client-request-id` (first-party only).

Other HTTP via axios: `filesApi.ts`, `bootstrap.ts`, `sessionIngress.ts`, etc.
`src/utils/http.ts`: `getAuthHeaders`, `getUserAgent`, `withOAuth401Retry`.

### 9.2 Streaming `[SRC:src/services/api/claude.ts]`

`queryModelWithStreaming`/`queryModel` calls
`anthropic.beta.messages.create({stream:true})` through `withRetry`, consumes
`Stream<BetaRawMessageStreamEvent>` (`message_start`, `content_block_start/delta/stop`,
`message_delta/stop`), accumulates `contentBlocks`/usage; idle watchdog, stall
detection, non-streaming fallback `executeNonStreamingRequest` (bounded timeout),
stream resource cleanup.

### 9.3 Auth headers `[SRC:src/services/api/client.ts, utils/auth.ts]`

- First-party: API key (`x-api-key`) or OAuth Bearer + `OAUTH_BETA_HEADER`;
  `configureApiKeyHeaders` supports `ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper`.
- Bedrock: AWS creds/bearer token + region.
- Foundry: API key or Azure AD token provider.
- Vertex: GoogleAuth.
- Refresh helpers in `src/utils/auth.js`.

### 9.4 Retry `[SRC:src/services/api/withRetry.ts]`

Default max 10. Handles 429/529, fast-mode cooldown/fallback, model fallback after
3 consecutive 529s, max-tokens overflow adjustment, persistent unattended retry
with heartbeats, auth refresh (401/revoked token, cloud creds), stale socket
disable keepalive, exponential backoff + retry-after.

### 9.5 Beta headers `[SRC:src/constants/betas.ts, utils/betas.ts]`

`getAllModelBetas`/`getMergedBetas` select by provider/model/feature/env;
`claude.ts` adds dynamic headers (tool search, context management, effort,
structured outputs, fast mode, afk, cache editing, thinking clear, advisor, task
budgets, 1M context) with sticky latches.

### 9.6 Request/response shapes `[SRC:src/services/api/claude.ts]`

`BetaMessageStreamParams`: `model`, `messages`, `system` (`TextBlockParam[]`),
`tools` (`BetaToolUnion[]`), `tool_choice`, `betas`, `metadata`, `max_tokens`,
`thinking`, `temperature`, `context_management`, `output_config`, `speed`,
extra body. Responses: `BetaMessage`, `BetaUsage`/`BetaMessageDeltaUsage` (incl.
`server_tool_use` web search/fetch counts), stream events. Blocks: `tool_use`,
`server_tool_use`, `tool_result`, `tool_reference`, `cache_edits`,
`advisor_tool_result`, text/thinking/redacted.

### 9.7 Tool use schema conversion `[SRC:src/utils/api.ts]`

`toolToAPISchema` builds `BetaToolUnion` with `defer_loading`, `cache_control`,
`strict`, `eager_input_streaming`. `claude.ts` normalizes messages, repairs
tool_use/tool_result pairing, supports advisor server tool, cached microcompact
`cache_reference` on tool_results.

### 9.8 Compaction API `[SRC:src/services/compact/apiMicrocompact.ts, compact.ts]`

- `context_management` edits: `clear_thinking_20251015`, `clear_tool_uses_20250919`
  with triggers/keep/clear.
- `compact.ts` uses `queryModelWithStreaming` for summaries.
- Context management sent when beta header present.

### 9.9 Prompt caching `[SRC:src/utils/api.ts, services/api/promptCacheBreakDetection.ts]`

- `splitSysPromptPrefix`/`buildSystemPromptBlocks` apply `cache_control` with
  scope `global`/`org`/null and 1h TTL via `getCacheControl`/`should1hCacheTTL`.
- `addCacheBreakpoints` marks last message, cache_edits, cache_reference on
  tool_results for cached microcompact.
- Env disables: `DISABLE_PROMPT_CACHING*`.
- `promptCacheBreakDetection.ts` monitors breaks.
- Global scope first-party only.

### 9.10 MCP protocol `[SRC:src/services/mcp/*]`

Claude Code acts as MCP client (stdio + streamable HTTP). Handshake, `tools/list`,
`tools/call`. Servers start once per run before first request, in name order;
tools become `mcp__<server>__<tool>`. One that fails to start is left out with a
note. Local server gets only PATH/HOME/locale, never API keys. Call timeout
120s. Policy: `allowedMcpServers`/`deniedMcpServers` in settings; `allowManagedMcpServersOnly`.

Config scopes `[SRC:src/services/mcp/config.ts]`:
- project: `<cwd>/.mcp.json` (parent dirs traversed).
- user: `mcpServers` in `~/.claude.json`.
- local: project entry in `~/.claude.json` (`projects[<path>].mcpServers`).
- enterprise: `<managed path>/managed-mcp.json` (exclusive if present).
- Claude.ai connectors fetched remotely and merged.

Plugin-provided MCP servers `[SRC:src/utils/plugins/mcpPluginIntegration.ts]`.

### 9.11 LSP `[SRC:src/services/lsp/*]`

LSP servers provided **only** via plugins (not user/project settings). Managed by
`LSPServerManager`/`LSPClient`. `[SRC:src/services/lsp/config.ts]`.

### 9.12 OAuth `[SRC:src/services/oauth/*]`

PKCE authorization code flow with localhost listener + manual paste. Tokens
persisted in secure storage (Keychain → `.credentials.json`). Scopes:
`user:inference`, `user:profile`, `user:sessions:claude_code`,
`user:mcp_servers`, `user:file_upload`, `org:create_api_key`. Global config
`~/.claude.json` stores profile/account state (suffix by oauth config type).

### 9.13 Policy limits `[SRC:src/services/policyLimits/index.ts]`

Eligibility based on OAuth subscription (enterprise/team) or API key. Cache
`~/.claude/policy-limits.json` (mode 0600); endpoint
`${BASE_API_URL}/api/claude_code/policy_limits`; polling/refresh on login.
Consumed via `isPolicyAllowed`.

### 9.14 Remote managed settings `[SRC:src/services/remoteManagedSettings/*]`

Cache `~/.claude/remote-settings.json`; endpoint
`${BASE_API_URL}/api/claude_code/settings`; ETag/checksum; security check on
changes; background polling every hour; hot-reload via
`settingsChangeDetector.notifyChange('policySettings')`.

### 9.15 Settings sync `[SRC:src/services/settingsSync/*]`

Feature-gated upload (interactive) / download (CCR) of user settings & memory
files. Backend `/api/claude_code/user_settings`; MD5 checksum; entries keyed by
virtual paths (`SYNC_KEYS`).

### 9.16 Upstream proxy (CCR) `[SRC:src/upstreamproxy/upstreamproxy.ts]`

Enabled when `CLAUDE_CODE_REMOTE` + `CCR_UPSTREAM_PROXY_ENABLED`; reads
`/run/ccr/session_token`; writes `~/.ccr/ca-bundle.crt`; local CONNECT→WebSocket
relay; exposes `HTTPS_PROXY` etc. to subprocesses.

---

## 10. Compaction & context management

`[SRC:src/services/compact/*, query.ts]`

- `autoCompactEnabled` in global config; thresholds/env overrides
  (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
  `DISABLE_AUTO_COMPACT`).
- Session-memory compaction attempted first (`trySessionMemoryCompaction`).
- Layers: tool-result budget, HISTORY_SNIP, microcompact (cached cache-edits
  boundary), CONTEXT_COLLAPSE, autocompact, reactive compact on PTL/media errors.
- Auto-compact tracking state resets on compact; task_budget remaining carried
  across compaction boundaries.
- `--autocompact <auto|tokens>` (v2.1.304) `[BIN]`.

---

## 11. Memory system

### 11.1 Auto-memory `[SRC:src/memdir/*]`

- Location: `~/.claude/projects/<sanitized-git-root>/memory/` with `MEMORY.md`
  entrypoint.
- `extractMemories` service: background fork writes durable memories to
  auto-memory dir `[SRC:src/services/extractMemories/extractMemories.ts]`.
- `autoDream`: consolidation lock file `.consolidate-lock` in memory dir
  (mtime = lastConsolidatedAt); scans session transcripts
  `[SRC:src/services/autoDream/*]`.

### 11.2 Session memory `[SRC:src/services/SessionMemory/*]`

`summary.md` per session.

### 11.3 CLAUDE.md memory files `[SRC:src/utils/claudemd.ts]`

Managed `/etc/claude-code/CLAUDE.md`, user `~/.claude/CLAUDE.md`, project
`CLAUDE.md`/`.claude/CLAUDE.md`/`.claude/rules/*.md`, local `CLAUDE.local.md`.

### 11.4 MagicDocs `[SRC:src/services/MagicDocs/magicDocs.ts]`

In-memory tracked set of files with `# MAGIC DOC:` header; updates via forked
agent.

### 11.5 AgentSummary `[SRC:src/services/AgentSummary/agentSummary.ts]`

Periodic forked summaries stored on task state (UI).

---

## 12. Skills & plugins

### 12.1 Skills `[SRC:src/skills/*, utils/skills/*]`

- Format: folder with `SKILL.md` (front matter `name`, `description`).
- Locations: `~/.claude/skills` (user; wins name conflicts) and
  `.claude/skills`, `.agents/skills` from cwd up to repo root, nearest first.
- At most 50. Only names+descriptions in first turn (`<skills>` frame, 8k cap).
- `SkillTool` loads skill text + lists files.
- `/skill-name` invocation.

Bundled skills `[SRC:src/skills/bundled/*]` (17 bundled).

### 12.2 Plugins `[SRC:src/utils/plugins/*, services/plugins/*]`

- Plugins provide commands, agents, output styles, hooks, MCP servers, LSP servers.
- Enabled via `enabledPlugins` in settings + managed policy.
- Install metadata: `~/.claude/plugins/installed_plugins.json` (V2) with
  migration from V1.
- Marketplaces: `known_marketplaces.json`.
- Per-plugin data: `~/.claude/plugins/data/<sanitized-plugin-id>`.
- Seed dirs for read-only pre-baked caches.
- Plugin-only restriction for MCP via `isRestrictedToPluginOnly('mcp')`.
- Commands: `plugin|plugins` (validate/list/install/uninstall/enable/disable/update),
  `marketplace` (add/list/remove/update).

---

## 13. Hooks

`[SRC:src/utils/hooks/*, services? ]` `[UNK: exact hook config schema]`

Settings `hooks` (user/managed only; repo cannot run code outside sandbox).
Points: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`,
`SessionEnd`, etc. Each hook is command/prompt/agent/http. Hook config in
settings.json. `--include-hook-events` for stream output. `--bare` skips hooks
defined in settings/plugins but not built-in features.

---

## 14. MCP

See §9.10. Commands: `mcp` (serve/remove/list/get/add/add-json/add-from-claude-desktop/
reset-project-choices). `--mcp-config`, `--strict-mcp-config`.

---

## 15. Tasks, agents, teams, coordinator

### 15.1 Task system `[SRC:src/tasks/*, tasks.ts]`

`TaskState` union: LocalShell, LocalAgent, RemoteAgent, InProcessTeammate,
LocalWorkflow, MonitorMcp, Dream. `isBackgroundTask()` filters running/pending
and not foreground.

Implementations: `LocalAgentTask`, `LocalShellTask`, `RemoteAgentTask`,
`InProcessTeammateTask`, `DreamTask`, `LocalMainSessionTask`, stopTask.

### 15.2 Agent tool `[SRC:src/tools/AgentTool/*]`

Params: `description`, `prompt`, `subagent_type`, `model`, `run_in_background`,
`name`, `team_name`, `mode`, `isolation`, `cwd`. Subagent types defined in
`src/tools/AgentTool/built-in/*.ts` and agent definitions.

### 15.3 Coordinator mode `[SRC:src/coordinator/coordinatorMode.ts]`

Gated by `COORDINATOR_MODE` feature + `CLAUDE_CODE_COORDINATOR_MODE` env.
`isCoordinatorMode()`, `matchSessionMode()` (resume mode reconciliation),
`getCoordinatorUserContext()` (worker tools list, MCP servers, scratchpad),
`getCoordinatorSystemPrompt()` (orchestrator prompt: AgentTool/SendMessage/TaskStop,
task workflow phases, worker prompt synthesis guidance).

### 15.4 Teams `[SRC:src/tools/TeamCreateTool, TeamDeleteTool, utils/swarm/*]`

`TeamCreateTool`: `team_name`, `description`, `agent_type`. `TeamDeleteTool`: no params.
Swarm utilities under `src/utils/swarm/`.

### 15.5 Background agents `[BIN]`

`agents`, `attach`, `logs`, `rm`, `stop|kill`, `respawn`, `--bg/--background`,
`--cloud`, `--environment`. `[UNK: exact lifecycle protocol]`.

---

## 16. Screens & UI (TUI)

### 16.1 Screens `[SRC:src/screens/]`

- `REPL.tsx`: main interactive session UI — message list (`Messages`/
  `VirtualMessageList`), `PromptInput`, transcript toggle, history search,
  message selector/rewind, surveys, cost/idle dialogs, permission/tool JSX
  overlays, ultraplan, desktop upsell.
- `Doctor.tsx`: diagnostics (versions, settings errors, keybinding warnings,
  MCP warnings, sandbox info).
- `ResumeConversation.tsx`: session picker/resume flow.

### 16.2 REPL overlays `[SRC:src/screens/REPL.tsx]`

Focused dialog priority system (`getFocusedInputDialog`) routes: message-selector,
sandbox-permission, tool-permission, prompt, worker-sandbox-permission,
elicitation, cost, idle-return, init-onboarding, ide-onboarding, model-switch,
undercover-callout, effort-callout, remote-callout, lsp-recommendation,
plugin-hint, desktop-upsell, ultraplan-choice/launch.

### 16.3 Permission dialogs `[SRC:src/components/permissions/]`

Router `PermissionRequest.tsx` maps tool → specialized request (Bash, PowerShell,
FileEdit, FileWrite, WebFetch, Notebook, Skill, AskUserQuestion, Enter/ExitPlanMode,
Filesystem, Sed, Fallback, etc.). Shared: `PermissionDialog`, `PermissionPrompt`,
`PermissionRequestTitle`, explanation/debug, rules UI.

### 16.4 Settings UI `[SRC:src/components/Settings/]`

`Settings.tsx`: tabs Status/Config/Usage (gated), Esc handling, search mode in
Config. `Status.tsx`, `Config.tsx`, `Usage.tsx`.

### 16.5 Onboarding `[SRC:src/components/Onboarding.tsx, interactiveHelpers.tsx]`

Preflight, theme, api-key approval, oauth, security notes, terminal setup; plus
Grove, Claude-in-Chrome, bypass/auto-mode opt-in, dev channels dialogs in
`showSetupScreens()`.

### 16.6 Trust dialog `[SRC:src/components/TrustDialog/TrustDialog.tsx]`

See §6.

### 16.7 Keybindings `[SRC:src/keybindings/]`

Contexts: Global, Chat, Autocomplete, Settings, Confirmation, Tabs, Transcript,
HistorySearch, Task, ThemePicker, Scroll, Help, Attachments, Footer,
MessageSelector, MessageActions, DiffDialog, ModelPicker, Select, Plugin.

User overrides via `~/.claude/keybindings.json` (`loadUserBindings.ts`); provider
setup `KeybindingProviderSetup.tsx`; chord timeout 1000ms; `ChordInterceptor`.

### 16.8 Vim mode `[SRC:src/vim/*, commands/vim/vim.ts]`

Toggle via `/vim` sets `editorMode` in config. State machine: INSERT/NORMAL,
operators d/c/y, motions, text objects, find, counts, dot-repeat. Input handling
`hooks/useVimInput.ts`.

### 16.9 Status line `[SRC:src/components/StatusLine.tsx]`

Renders via configured `settings.statusLine` command; builds
`StatusLineCommandInput` (model, workspace, cost, context window, vim mode,
permission mode, rate limits, worktree, etc.) and executes status line command.

### 16.10 Ink renderer `[SRC:src/ink/*]`

`Ink` class: Yoga layout, React reconciler commit → `scheduleRender` (throttled
microtask) → `onRender`: renderer computes `Frame` from DOM/yoga, selection/search
overlays, diff via `LogUpdate`, optimize, write to terminal. Handles resize,
alt-screen, pause/resume, SIGCONT, mouse/selection.

### 16.11 Accessibility `[BIN]`

`--ax-screen-reader`: flat text, no decorative borders/animations.

---

## 17. Voice, buddy, bridge, remote

### 17.1 Voice `[SRC:src/voice/*, commands/voice]` `[UNK]`

Voice mode command and audio handling. `[UNK: protocol details]`.

### 17.2 Buddy `[SRC:src/buddy/*, commands/buddy]`

Companion feature. `[UNK]`.

### 17.3 Bridge / remote control `[SRC:src/bridge/*, remote/*, server/*]`

Bridge mode for IDE/remote. Commands: `remote-control/rc`. `open <cc-url>`.
Remote sessions, direct-connect server (`server`), SSH. Teleport (`--teleport`).
Cloud sessions (`--cloud`, `--environment`).

### 17.4 Chrome integration `[SRC:src/utils/claudeInChrome/*, commands/chrome]`

`--chrome/--no-chrome`. Claude in Chrome integration.

### 17.5 Computer use `[SRC:src/utils/computerUse/*]`

`--computer-use-mcp`.

---

## 18. Output styles, themes, terminal setup

`[SRC:src/outputStyles/*, components/...]` Output styles configurable. Themes via
`/theme`. Terminal setup `/terminalSetup`. Color `/color`.

---

## 19. Cost tracking & telemetry

`[SRC:src/cost-tracker.ts, bootstrap/state.ts]`
- `addToTotalSessionCost()` accumulates per-model usage + USD via
  `calculateUSDCost`, updates bootstrap state, OTel counters; handles advisor
  usage recursively.
- Persistence via `saveCurrentSessionCosts`/`restoreCostStateForSession` keyed by
  session id in project config.
- `getTotalCost`, `getModelUsage`, `formatTotalCost`.
- No telemetry to Anthropic beyond provider; policy limits gate.

---

## 20. Error behaviors

- Tool errors returned to model as tool_result with `is_error`; loop continues.
- Permission denial returns reason to model; run continues (never blocks).
- PTL (prompt too long): recovery via collapse drain / reactive compact.
- Max output tokens: recovery loop (up to 3) with meta message.
- Media size errors: reactive compact.
- Model fallback after 3 consecutive 529s.
- Auth errors: refresh + retry; cloud creds refresh.
- Stream stall/idle watchdog → non-streaming fallback.
- MCP server failure at start: left out with note.
- LSP server failure: reported once on stderr, not retried.
- Hooks: exit code 0 proceed, 2 block with stderr reason, other fail closed.
- Auto-compact disabled under certain errors; tracking resets.
- Session persistence: append-only JSONL; fork via parentId.
- `--max-budget-usd` stops with error_max_budget_usd.
- `--max-turns` stops with error_max_turns.

---

## 21. Edge cases (selected)

- Simple mode (`CLAUDE_CODE_SIMPLE`/`--bare`): skips hooks (settings/plugins),
  LSP, plugin sync, attribution, auto-memory, background prefetches, keychain
  reads, CLAUDE.md auto-discovery. Auth strictly API key or apiKeyHelper.
- Worktree: `-w/--worktree` creates git worktree; `--tmux`.
- Resume/fork: `--resume`, `--continue`, `--fork-session`, `--resume-session-at`.
- Rewind files: `--rewind-files`.
- From PR: `--from-pr`.
- Teleport: `--teleport`.
- Restricted mode: removes code-running tools + WebFetch unless named; confines
  file tools to working dirs; refuses bypassPermissions.
- Safe mode: disables all customizations (CLAUDE.md, skills, plugins, hooks, MCP,
  commands, agents, output styles, workflows, themes, keybindings); policy settings
  still apply.
- System prompt snapshot: record once per conversation and reuse verbatim on
  every request/resume (default on except `--bare` outside cloud/bg). Off = render
  fresh each request.
- Exclude dynamic system prompt sections: move per-machine sections (cwd, env,
  memory paths, git status) from system prompt into first user message for
  cross-user cache reuse.
- Prompt suggestions: emits predicted next user prompt after each turn (print/SDK).
- Forward subagent text: `--forward-subagent-text`.
- Background sessions: `--bg`, attach/logs/stop/rm/respawn.
- Cloud sessions: `--cloud`, `--environment`.
- Purge: delete all state for a project.

---

## 22. Directory/file skeleton mapping

The clone skeleton mirrors `src/` of the leaked snapshot (1,902 files) under
`~/cedia/claude-code/src/` as empty placeholders. Implementer fills from this
spec. Top-level mapping:

```
claude-code/
  src/
    entrypoints/   cli.tsx init.ts mcp.ts sdk/
    commands/      (one dir per slash command)
    tools/         (one dir per tool)
    query/         deps.ts config.ts transitions.ts tokenBudget.ts stopHooks.ts
    services/      api/ mcp/ lsp/ compact/ oauth/ plugins/ settingsSync/ ...
    utils/         settings/ permissions/ sandbox/ git/ model/ ...
    components/    permissions/ Settings/ ...
    screens/       REPL.tsx Doctor.tsx ResumeConversation.tsx
    state/         store.ts AppStateStore.ts AppState.tsx selectors.ts
    ink/           root.ts ink.tsx reconciler.ts dom.ts ...
    keybindings/   schema.ts ...
    vim/           types.ts transitions.ts motions.ts ...
    hooks/         (React hooks)
    context/       ...
    coordinator/   coordinatorMode.ts
    tasks/         types.ts + implementations
    memdir/        paths.ts ...
    migrations/
    plugins/       bundled/
    skills/        bundled/
    bootstrap/     state.ts
    remote/ server/
    types/ schemas/
    voice/ buddy/ assistant/ bridge/
```

---

## 23. Evidence gaps / UNKNOWN

- Exact session JSONL event schema beyond first-line `session` event: `[UNK]`.
- Hook configuration full schema and event list: `[UNK]`.
- Voice protocol/audio handling: `[UNK]`.
- Buddy feature details: `[UNK]`.
- Auto mode classifier prompt: `[UNK]`.
- Coordinator worker protocol details: `[UNK]`.
- Exact MCP handshake error handling beyond "method not found" for server
  requests: `[UNK]`.
- Plugin manifest schema (`plugin.json`) full fields: `[UNK]`.
- Remote control / bridge wire protocol: `[UNK]`.
- Cloud session protocol: `[UNK]`.
- Background agent attach/log transport: `[UNK]`.
- Ultrareview / ultraplan internals: `[UNK]`.
- Permission auto-mode classifier details: `[UNK]`.
- Telemetry/OTel exporter config: `[UNK]`.

Use REA against `/opt/homebrew/bin/claude` (v2.1.304) to close these gaps for the
current version.

---

## 24. Implementation notes for clone

- Language/runtime: TypeScript on Bun (matches leak).
- TUI: React + Ink (as leak).
- Sandbox: `@anthropic-ai/sandbox-runtime`.
- API: Anthropic SDK with Bedrock/Vertex/Foundry branches.
- MCP client: stdio + streamable HTTP.
- LSP: plugin-provided only.
- Auth: API key / OAuth PKCE / Bedrock / Vertex / Foundry.
- No Claude.ai impersonation; API keys only (per cedia policy).
- Clean-room: rewrite from this spec; do not copy leaked code/assets.
