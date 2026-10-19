import { type AssistantMessage, StringEnum } from "@earendil-works/pi-ai";
import { compact, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAnswers, NO_UI_ANSWER, OTHER } from "./ask.ts";
import { classifyCommand } from "./classifier.ts";
import { gateReason } from "./gate.ts";
import { handoffInstructions, skillName } from "./handoff.ts";
import { emptyGoalState, goalStatus, startGoal, stopGoal, verifyGoal } from "./goal.ts";
import { autoTarget, PSTACK_MODELS, type Target } from "./models.ts";
import { emptyCompactionTracker, onCompact, onTurnStart, shouldCompact } from "./compaction.ts";
import { approveDomain, checkConsent, probeEgress, summarizeContent } from "./webfetch_consent.ts";
import { getDiagnostics, formatDiagnostics, getHover, getDefinition } from "./lsp.ts";
import { emptyReadState, isStale, recordRead, wasRead } from "./readstate.ts";
import { memoryDelete, memoryList, memoryRead, memorySearch, memoryWrite } from "./memory.ts";
import { applyPatch } from "./applypatch.ts";
import { checkpointDir, createCheckpoint, initCheckpoint, undoCheckpoint } from "./checkpoint.ts";
import { diagnose } from "./diagnostics.ts";
import { defaultSandboxConfig, wrapCommand } from "./sandbox.ts";
import { extractDomain, fetchUrl, isDenied } from "./webfetch.ts";
import { formatAllFailures, formatSearchResponse, searchChain, type SearchSource } from "./websearch.ts";
import { REVIEW_PROMPT, parseFindings, verifyFinding, formatFindings } from "./review.ts";
import { AgentRunner } from "./task/agents.ts";
import { registerAgentTools } from "./task/agent-tools.ts";
import { defaultSettings, DEPTH_FLAG } from "./task/config.ts";
import { asksForAutonomy, continuation, isSilentToolStep, openTodos, STATUS_REMINDER, type Todo } from "./loop.ts";
import { crossedBudget, dayFile, parseRecords, type RequestRecord, statusLine, toRecord, totals } from "./telemetry.ts";
import { claimNudge, detectClaims, emptyLedger, ledgerStatus, markInput, receipt, recordBashChanges, recordToolResult } from "./trust.ts";

const CEDIA_TOOLS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../prompts/cedia-tools.md"), "utf8");

const MAX_CLAIM_NUDGES_PER_INPUT = 1;
const MAX_CONTINUATIONS_PER_INPUT = 2;
const MAX_STATUS_REMINDERS_PER_INPUT = 2;
const SILENT_STEPS_BEFORE_REMINDER = 5;

const AskOption = Type.Union([
  Type.String(),
  Type.Object({
    label: Type.String(),
    description: Type.Optional(Type.String()),
  }),
]);
const AskParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "One decision the user must make, as a complete question" }),
      options: Type.Array(AskOption, { minItems: 2, maxItems: 4, description: "Choices; put a recommended one first" }),
      multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options" })),
      recommended: Type.Optional(Type.Integer({ minimum: 0, description: "Index of the recommended option (0-based)" })),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

const TodoParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "What to do, in the imperative" }),
      status: StringEnum(["pending", "in_progress", "completed"] as const),
    }),
    { description: "The complete list; it replaces the previous one" },
  ),
});

export interface CediaOptions {
  telemetryDir?: string;
  dailyBudgetUsd?: number;
  now?: () => Date;
}

export default function cedia(pi: ExtensionAPI): void {
  createCedia()(pi);
}

export function createCedia(options: CediaOptions = {}): (pi: ExtensionAPI) => void {
  const telemetryDir = options.telemetryDir ?? join(getAgentDir(), "telemetry");
  const budgetUsd = options.dailyBudgetUsd ?? Number(process.env.CEDIA_DAILY_BUDGET_USD ?? 20);
  const now = options.now ?? (() => new Date());

  return (pi) => {
    let taskRunner: AgentRunner | undefined;
    let cpDir: string | undefined;
    const ledger = emptyLedger();
    const sandboxConfig = defaultSandboxConfig();
    const bashSnapshots = new Map<string, string[]>();
    const goalState = emptyGoalState();
    const readState = emptyReadState();
    const compactionTracker = emptyCompactionTracker();
    let turnStartedAt = 0;
    let firstAssistantAt = 0;
    const gitChangedPaths = (cwd?: string): string[] | undefined => {
      try {
        const out = execSync("git status --porcelain", { cwd: cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^[ MADRCU?!]{1,2}\s+/, "").replace(/^"(.*)"$/, "$1"));
      } catch {
        return undefined;
      }
    };
    const recentReads: string[] = [];
    const sessionRecords: RequestRecord[] = [];
    let nudges = 0;
    let continuations = 0;
    let reminders = 0;
    let silentSteps = 0;
    let autonomous = false;
    let planMode = false;
    let todos: Todo[] = [];
    const skills = new Set<string>();
    let requestStartedAt = 0;

    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, "cedia-tools": CEDIA_TOOLS };
    });

    let lastUserText = "";
    pi.on("input", (event) => {
      markInput(ledger);
      nudges = continuations = reminders = silentSteps = 0;
      autonomous = asksForAutonomy(event.text);
      lastUserText = event.text;
    });

    const restoreTodos = (ctx: ExtensionContext) => {
      todos = [];
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "TodoWrite") {
          todos = (entry.message.details as { todos?: Todo[] } | undefined)?.todos ?? todos;
        }
      }
    };
    pi.on("session_start", (_event, ctx) => { restoreTodos(ctx); try { cpDir = initCheckpoint(ctx.cwd, ctx.sessionManager.getSessionId()); } catch {} });
    pi.on("session_tree", (_event, ctx) => restoreTodos(ctx));

    pi.registerTool({
      name: "TodoWrite",
      label: "Todos",
      description: "Track the steps of multi-step work. Send the complete list every time; mark an item in_progress before starting it and completed as soon as it is done.",
      parameters: TodoParams,
      async execute(_id, params) {
        todos = params.todos;
        const open = openTodos(todos).length;
        return { content: [{ type: "text", text: `${todos.length - open}/${todos.length} completed` }], details: { todos } };
      },
    });

    const resolve = (target: Target, ctx: ExtensionContext) => {
      const model = ctx.modelRegistry.find(target.provider, target.id);
      if (!model) throw new Error(`cedia: ${target.provider}/${target.id} is not in the model catalog`);
      return { model, thinkingLevel: target.thinkingLevel };
    };
    pi.registerVirtualModel({
      provider: "cedia",
      id: "auto",
      name: "cedia auto (low = Haiku, else Opus)",
      thinkingLevels: ["low", "medium"],
      route(request, ctx) {
        const sticky = request.reason === "retry" ? request.failed : request.reason === "continuation" ? request.previous : undefined;
        if (sticky) return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
        return resolve(autoTarget(request.thinkingLevel), ctx);
      },
    });
    for (const [id, target] of Object.entries(PSTACK_MODELS)) {
      pi.registerVirtualModel({ provider: "cedia", id, name: `${id} → ${target.id} @${target.thinkingLevel}`, route: (_request, ctx) => resolve(target, ctx) });
    }

    pi.registerTool({
      name: "AskQuestion",
      label: "Ask",
      description: "Ask the user 1-4 multiple-choice questions when a decision is genuinely theirs. The user can always type their own answer.",
      parameters: AskParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!ctx.hasUI) return { content: [{ type: "text", text: NO_UI_ANSWER }], details: { answered: false } };
        const answers: (string | undefined)[] = [];
        for (const q of params.questions) {
          const labels = q.options.map((o) => (typeof o === "string" ? o : o.label));
          const display = labels.map((label, i) => (i === q.recommended ? `${label} (Recommended)` : label));
          if (q.multiSelect) {
            const picked: string[] = [];
            let more = true;
            while (more) {
            const choice = await ctx.ui.select(`${q.question} (select one; choose "Done" when finished)`, [...display, "Done", OTHER]);
            if (!choice) { more = false; continue; }
            if (choice === "Done") { more = false; continue; }
            if (choice === OTHER) { const t = await ctx.ui.input(q.question); if (t) picked.push(t); more = false; continue; }
            const label = labels[display.indexOf(choice.replace(" (Recommended)", ""))];
            if (label && !picked.includes(label)) picked.push(label);
            }
            answers.push(picked.length ? picked.join(", ") : undefined);
          } else {
            const choice = await ctx.ui.select(q.question, [...display, OTHER]);
            if (!choice) { answers.push(undefined); continue; }
            answers.push(choice === OTHER ? await ctx.ui.input(q.question) : labels[display.indexOf(choice.replace(" (Recommended)", ""))]);
          }
        }
        const formatQuestions = params.questions.map((q) => ({ question: q.question, options: q.options.map((o) => (typeof o === "string" ? o : o.label)) }));
        return { content: [{ type: "text", text: formatAnswers(formatQuestions, answers) }], details: { answered: true, answers } };
      },
    });
    pi.registerTool({
      name: "WebFetch",
      label: "WebFetch",
      description: "Fetch a URL and return its content as markdown. Use for reading web pages, documentation, and articles.",
      parameters: Type.Object({ url: Type.String({ description: "The URL to fetch" }) }),
      async execute(_id, params) {
        const denyDomains = (process.env.CEDIA_WEBFETCH_DENY_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
        const allowDomains = (process.env.CEDIA_WEBFETCH_ALLOW_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
        const consent = checkConsent(params.url, denyDomains, allowDomains);
        if (!consent.allowed) {
          return { content: [{ type: "text", text: `Blocked: ${consent.reason}` }], details: { url: params.url, title: undefined }, isError: true };
        }
        // Egress probe
        const reachable = await probeEgress(params.url);
        if (!reachable) {
          return { content: [{ type: "text", text: `Blocked: ${params.url} is not reachable.` }], details: { url: params.url, title: undefined }, isError: true };
        }
        try {
          const result = await fetchUrl(params.url);
          // Second deny check (after redirect)
          const finalConsent = checkConsent(result.url, denyDomains, allowDomains);
          if (!finalConsent.allowed) {
            return { content: [{ type: "text", text: `Blocked after redirect: ${finalConsent.reason}` }], details: { url: result.url, title: undefined }, isError: true };
          }
          // Approve domain for future (shared read consent)
          approveDomain(consent.domain);
          const content = summarizeContent(result.content);
          const title = result.title ? `# ${result.title}\n\n` : "";
          return { content: [{ type: "text", text: `${title}${content}` }], details: { url: result.url, title: result.title } };
        } catch (e) {
          return { content: [{ type: "text", text: `Error fetching ${params.url}: ${e instanceof Error ? e.message : String(e)}` }], details: { url: params.url, title: undefined }, isError: true };
        }
      },
    });
    pi.registerTool({
      name: "WebSearch",
      label: "WebSearch",
      description: "Search the web for information. Returns an answer with sources when available, else titles, URLs, and snippets.",
      parameters: Type.Object({
        query: Type.String({ description: "The search query" }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Max sources to return" })),
        allowed_domains: Type.Optional(Type.Array(Type.String(), { description: "Only include results from these domains" })),
        blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Never include results from these domains" })),
      }),
      async execute(_id, params) {
        try {
          const { response, failures } = await searchChain(params.query, {
            allowedDomains: params.allowed_domains,
            blockedDomains: params.blocked_domains,
          });
          const limited: SearchSource[] =
            typeof params.limit === "number" ? response.sources.slice(0, params.limit) : response.sources;
          const text = formatSearchResponse({ ...response, sources: limited });
          const details = { query: params.query, count: limited.length, provider: response.provider };
          if (response.sources.length === 0 && !response.answer) {
            return { content: [{ type: "text", text: `${text}\n\nSearch failures: ${formatAllFailures(failures)}` }], details };
          }
          return { content: [{ type: "text", text }], details };
        } catch (e) {
          return { content: [{ type: "text", text: `Error searching: ${e instanceof Error ? e.message : String(e)}` }], details: { query: params.query, count: 0 }, isError: true };
        }
      },
    });
    pi.registerTool({
      name: "ApplyPatch",
      label: "ApplyPatch",
      description: "Apply a patch in apply_patch format (*** Begin Patch / *** Update File: / *** Add File: / *** Delete File: / *** End Patch). Use for multi-file edits.",
      parameters: Type.Object({ patch: Type.String({ description: "The patch in apply_patch format" }) }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const result = applyPatch(params.patch, ctx.cwd);
        if (!result.ok) {
          return { content: [{ type: "text", text: `Patch failed: ${result.error}\nApplied: ${result.applied.join(", ")}` }], details: { applied: result.applied }, isError: true };
        }
        return { content: [{ type: "text", text: `Patch applied: ${result.applied.join(", ")}` }], details: { applied: result.applied } };
      },
    });

    pi.registerTool({
      name: "memory_write",
      label: "MemoryWrite",
      description: "Write a fact to cross-session memory. Persists across sessions.",
      parameters: Type.Object({ key: Type.String({ description: "Memory key" }), content: Type.String({ description: "Content to store" }) }),
      async execute(_id, params) {
        memoryWrite(params.key, params.content);
        return { content: [{ type: "text", text: `Stored memory: ${params.key}` }], details: { key: params.key } };
      },
    });
    pi.registerTool({
      name: "memory_read",
      label: "MemoryRead",
      description: "Read a fact from cross-session memory.",
      parameters: Type.Object({ key: Type.String({ description: "Memory key" }) }),
      async execute(_id, params) {
        const content = memoryRead(params.key);
        if (content === undefined) return { content: [{ type: "text", text: `No memory found for: ${params.key}` }], details: { key: params.key, found: false } };
        return { content: [{ type: "text", text: content }], details: { key: params.key, found: true } };
      },
    });
    pi.registerTool({
      name: "memory_list",
      label: "MemoryList",
      description: "List all stored memory keys.",
      parameters: Type.Object({}),
      async execute() {
        const keys = memoryList();
        return { content: [{ type: "text", text: keys.length ? keys.join("\n") : "No memories stored." }], details: { keys } };
      },
    });
    pi.registerTool({
      name: "memory_search",
      label: "MemorySearch",
      description: "Search cross-session memory by keyword. Returns matching keys and snippets.",
      parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
      async execute(_id, params) {
        const results = memorySearch(params.query);
        if (results.length === 0) return { content: [{ type: "text", text: "No matching memories." }], details: { count: 0 } };
        const lines = results.map((r) => `${r.key}: ${r.snippet}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { count: results.length } };
      },
    });
    pi.registerTool({
      name: "lsp_hover",
      label: "LSPHover",
      description: "Get hover information for a symbol at a specific position in a file. Requires an LSP server (e.g., rust-analyzer).",
      parameters: Type.Object({ path: Type.String(), line: Type.Integer({ minimum: 1 }), character: Type.Integer({ minimum: 1 }) }),
      async execute(_id, params) {
        try {
          const result = await getHover(params.path, params.line, params.character, process.cwd());
          if (!result) return { content: [{ type: "text", text: "No hover information available." }], details: {} };
          return { content: [{ type: "text", text: result.contents }], details: {} };
        } catch (e) {
          return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], details: {}, isError: true };
        }
      },
    });
    pi.registerTool({
      name: "lsp_definition",
      label: "LSPDefinition",
      description: "Go to definition of a symbol at a specific position in a file. Requires an LSP server.",
      parameters: Type.Object({ path: Type.String(), line: Type.Integer({ minimum: 1 }), character: Type.Integer({ minimum: 1 }) }),
      async execute(_id, params) {
        try {
          const result = await getDefinition(params.path, params.line, params.character, process.cwd());
          if (!result || result.length === 0) return { content: [{ type: "text", text: "No definition found." }], details: {} };
          const text = result.map((l: any) => `${l.uri}:${l.range.start.line + 1}`).join("\n");
          return { content: [{ type: "text", text }], details: {} };
        } catch (e) {
          return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], details: {}, isError: true };
        }
      },
    });
    pi.on("turn_end", () => {
      if (silentSteps < SILENT_STEPS_BEFORE_REMINDER || reminders >= MAX_STATUS_REMINDERS_PER_INPUT) return;
      silentSteps = 0;
      reminders++;
      return { entries: [{ type: "custom_message", customType: "cedia.status-reminder", content: STATUS_REMINDER, display: false }] };
    });

    const noClassifier = process.env.CEDIA_NO_CLASSIFIER === "1";
    const noLsp = process.env.CEDIA_NO_LSP === "1";
    const noSnapshot = process.env.CEDIA_NO_SNAPSHOT === "1";
    pi.on("tool_call", async (event, ctx) => {
      if (planMode && ["edit", "write", "ApplyPatch", "bash", "Task", "memory_write"].includes(event.toolName)) {
        return { block: true, reason: "cedia: plan mode is read-only; /plan off to allow edits." };
      }
      if (!noSnapshot && event.toolName === "bash" && typeof event.input.command === "string") {
        const before = gitChangedPaths((ctx as any).cwd ?? process.cwd());
        if (before) bashSnapshots.set(event.toolCallId, before);
      }
      if (event.toolName === "bash" && typeof event.input.command === "string" && sandboxConfig.enabled) {
        event.input.command = wrapCommand(event.input.command, (ctx as any).cwd ?? process.cwd(), sandboxConfig);
      }
      if ((event.toolName === "edit" || event.toolName === "write") && cpDir) {
        try { createCheckpoint(cpDir, process.cwd(), `before ${event.toolName}`); } catch {}
      }
      if ((event.toolName === "edit" || event.toolName === "write") && typeof event.input.path === "string") {
        const path = event.input.path;
        if (existsSync(path) && (!wasRead(readState, path) || isStale(readState, path))) {
          return {
            block: true,
            reason: !wasRead(readState, path)
              ? "File has not been read yet. Read it first before writing to it."
              : "File content has changed since it was last read. Read it again before attempting to write it.",
          };
        }
      }
      if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
      const reason = gateReason(event.input.command);
      if (!reason) {
        const cmd = event.input.command;
        const needsClassify = /\b(rm|rmdir|git\s+push|curl|wget|chmod|chown|mv|cp)\b/.test(cmd);
        if (!noClassifier && needsClassify) {
          const result = await classifyCommand(cmd, ctx.modelRegistry, lastUserText);
          if (result.shouldBlock) {
            return {
              block: true,
              reason: `cedia classifier: ${result.reason}. Do not retry it; continue without it or ask the user how to proceed.`,
            };
          }
        }
        return;
      }
      if (ctx.hasUI && (await ctx.ui.confirm("cedia: confirm irreversible command", `${event.input.command}\n\n${reason}`))) return;
      return {
        block: true,
        reason: ctx.hasUI
          ? `The user declined: ${reason}. Do not retry it; continue without it or ask the user how to proceed.`
          : `Blocked without the user's approval: ${reason}. Nobody can approve it in this mode, so report it as a step the user must run.`,
      };
    });

    pi.on("tool_result", async (event) => {
      if (event.toolName === "read" && typeof event.input.path === "string") {
        const p = event.input.path;
        const skill = skillName(p);
        if (skill) skills.add(skill);
        const idx = recentReads.indexOf(p);
        if (idx !== -1) recentReads.splice(idx, 1);
        recentReads.unshift(p);
        if (recentReads.length > 10) recentReads.length = 10;
        recordRead(readState, p);
      }
      if (!noLsp && (event.toolName === "edit" || event.toolName === "write") && typeof event.input.path === "string") {
        // Try LSP diagnostics first
        try {
          const lspResult = await getDiagnostics(event.input.path, process.cwd());
          if (lspResult && lspResult.diagnostics.length > 0) {
            const diagText = formatDiagnostics(lspResult);
            const existing = Array.isArray(event.content) ? event.content : [];
            return { content: [...existing, { type: "text" as const, text: `\n\nLSP Diagnostics (${lspResult.server}):\n${diagText}` }] };
          }
        } catch {
          // LSP unavailable
        }
        // Fallback: tsc/eslint
        const diag = diagnose(event.input.path, process.cwd());
        if (diag && diag.output) {
          const existing = Array.isArray(event.content) ? event.content : [];
          return { content: [...existing, { type: "text" as const, text: `\n\nDiagnostics (${diag.command}):\n${diag.output}` }] };
        }
      }
      const exitCode = (event.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
      recordToolResult(ledger, event.toolName, event.input, event.isError, exitCode);
      if (!noSnapshot && event.toolName === "bash" && typeof event.input.command === "string") {
        const before = bashSnapshots.get(event.toolCallId);
        bashSnapshots.delete(event.toolCallId);
        const after = gitChangedPaths(process.cwd());
        if (before && after) {
          const beforeSet = new Set(before);
          const changed = after.filter((p) => !beforeSet.has(p));
          if (changed.length) recordBashChanges(ledger, changed);
        }
      } else if (event.toolName === "bash" && typeof event.input.command === "string") {
        bashSnapshots.delete(event.toolCallId);
      }
    });
    pi.on("turn_start", (event) => {
      turnStartedAt = event.timestamp || Date.now();
      onTurnStart(compactionTracker);
      firstAssistantAt = 0;
    });
    pi.on("message_start", (event) => {
      if (event.message.role === "assistant") {
        requestStartedAt = Date.now();
        if (!firstAssistantAt) firstAssistantAt = requestStartedAt;
      }
    });

    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "assistant") return;
      silentSteps = isSilentToolStep(event.message.content) ? silentSteps + 1 : 0;
      const at = now();
      const ms = turnStartedAt ? Date.now() - turnStartedAt : Date.now() - requestStartedAt;
      const ttftMs = turnStartedAt && firstAssistantAt ? firstAssistantAt - turnStartedAt : undefined;
      const record = toRecord(event.message as AssistantMessage, ctx.sessionManager.getSessionId(), ms, ttftMs, at);
      if (firstAssistantAt) firstAssistantAt = 0;
      const file = join(telemetryDir, dayFile(at));
      const before = totals(readDay(file)).costUsd;
      mkdirSync(telemetryDir, { recursive: true });
      appendFileSync(file, `${JSON.stringify(record)}\n`);
      sessionRecords.push(record);
      const today = totals(readDay(file));
      if (!ctx.hasUI) return;
      ctx.ui.setStatus("cedia", statusLine(totals(sessionRecords), today, budgetUsd));
      if (crossedBudget(before, today.costUsd, budgetUsd)) ctx.ui.notify(`cedia: today's spend passed $${budgetUsd} ($${today.costUsd.toFixed(2)}).`, "warning");
    });

    pi.on("agent_before_settle", async (event, ctx) => {
      if (event.outcome !== "completed") return;
      const status = ledgerStatus(ledger);
      const nudge = nudges < MAX_CLAIM_NUDGES_PER_INPUT ? claimNudge(status, detectClaims(lastAssistantText(event.context.llmMessages))) : undefined;
      if (nudge) {
        nudges++;
        return { continue: true, entries: [{ type: "custom_message", customType: "cedia.claim-check", content: nudge, display: true }] };
      }
      const open = openTodos(todos);
      if (open.length && (autonomous || !ctx.hasUI) && continuations < MAX_CONTINUATIONS_PER_INPUT) {
        continuations++;
        return { continue: true, entries: [{ type: "custom_message", customType: "cedia.continue", content: continuation(open), display: true }] };
      }
      if (goalState.active) {
        const recentEntries = ledger.entries.slice(goalState.lastCheckIndex);
        const lastCheck = [...recentEntries].reverse().find((e): e is Extract<typeof e, { kind: "check" }> => e.kind === "check");

        if (!lastCheck) {
          return { continue: true, entries: [{ type: "custom_message", customType: "cedia.goal", content: `Goal: ${goalState.outcome}. No check has run yet. Run the check that proves your goal, then continue.`, display: true }] };
        }

        if (lastCheck.exitCode !== 0) {
          return { continue: true, entries: [{ type: "custom_message", customType: "cedia.goal", content: `Goal: ${goalState.outcome}. Check failed (exit ${lastCheck.exitCode}): ${lastCheck.command}. Fix and retry.`, display: true }] };
        }

        if (goalState.round >= 3) {
          stopGoal(goalState);
          const r = receipt(status);
          return { entries: [{ type: "custom_message", customType: "cedia.goal", content: `Goal not fully met after 3 verify rounds.\n${r ?? ""}`, display: true }] };
        }

        const changedFiles = status.changed;
        const lastText = lastAssistantText(event.context.llmMessages);
        const verifyResult = await verifyGoal(
          goalState.outcome,
          lastCheck.command,
          lastCheck.exitCode,
          changedFiles,
          lastText,
          ctx.modelRegistry,
          ctx.model,
        );

        if (!verifyResult.refuted) {
          stopGoal(goalState);
          const r = receipt(status);
          return { entries: [{ type: "custom_message", customType: "cedia.goal", content: `Goal met ✓\n${r ?? ""}`, display: true }] };
        }

        goalState.round++;
        goalState.lastCheckIndex = ledger.entries.length;
        const gaps = verifyResult.gaps.length ? verifyResult.gaps.map((g) => `- ${g}`).join("\n") : "(none listed)";
        return { continue: true, entries: [{ type: "custom_message", customType: "cedia.goal", content: `Goal: ${goalState.outcome}. Verifier refuted (round ${goalState.round}/3): ${verifyResult.reason}\nGaps:\n${gaps}\nFix these and re-run the check.`, display: true }] };
      }

      const text = receipt(status);
      if (text) return { entries: [{ type: "custom_message", customType: "cedia.receipt", content: text, display: true }] };
    });

    // ponytail: summarizes with the session's model directly, skipping pi's virtual-model routing for summaries; upgrade when cedia/auto routes summaries elsewhere.
    pi.on("session_before_compact", async (event, ctx) => {
      if (!ctx.model) return;
      const compactCheck = shouldCompact(compactionTracker);
      if (!compactCheck.allow) {
        ctx.ui.notify(`cedia: ${compactCheck.reason}`, "warning");
        return;
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) return;
      const instructions = handoffInstructions({
        openTodos: openTodos(todos),
        unverified: ledgerStatus(ledger).unverified,
        skills: [...skills],
        focus: event.customInstructions,
        recentFiles: recentReads.slice(0, 5),
      });
      const stream = (model: Parameters<typeof ctx.modelRegistry.streamSimple>[0], context: Parameters<typeof ctx.modelRegistry.streamSimple>[1], opts?: Parameters<typeof ctx.modelRegistry.streamSimple>[2]) =>
        ctx.modelRegistry.streamSimple(model, context, opts);
      try {
        const result = await compact(event.preparation, ctx.model, auth.apiKey, definedHeaders(auth.headers), instructions, event.signal, ctx.thinkingLevel, stream);
        onCompact(compactionTracker);
        return { compaction: result };
      } catch (error) {
        ctx.ui.notify(`cedia: handoff summary failed (${error instanceof Error ? error.message : String(error)}); using pi's default compaction.`, "warning");
        return;
      }
    });

    pi.registerCommand("handoff", {
      description: "Compact this session into a handoff for the next focus: /handoff [focus]",
      handler: async (args, ctx) => {
        ctx.compact({ customInstructions: args });
      },
    });

    pi.registerCommand("receipt", {
      description: "Show what cedia recorded since your last message",
      handler: async (_args, ctx) => {
        ctx.ui.notify(receipt(ledgerStatus(ledger)) ?? "Nothing changed and no checks ran since your last message.", "info");
      },
    });
    pi.registerCommand("goal", {
      description: "Run in goal mode: /goal <outcome>, /goal off, or /goal (status)",
      handler: async (args, ctx) => {
        const trimmed = (args ?? "").trim();
        if (trimmed === "off") {
          stopGoal(goalState);
          ctx.ui.notify("cedia: goal mode off.", "info");
          return;
        }
        if (!trimmed) {
          ctx.ui.notify(`cedia: ${goalStatus(goalState)}`, "info");
          return;
        }
        if (goalState.active) stopGoal(goalState);
        startGoal(goalState, trimmed, ledger.entries.length);
        try {
          const dir = join(ctx.cwd ?? process.cwd(), ".cedia");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "goal.md"), `# Goal\n\n${trimmed}\n\nSet: ${new Date().toISOString()}\n`, "utf8");
        } catch {}
        ctx.ui.notify(`cedia: goal set — ${trimmed}`, "info");
        pi.sendMessage({ customType: "cedia.goal", content: `Goal: ${trimmed}. Work on it, then run the check that proves it.`, display: true }, { triggerTurn: true });
      },
    });
    pi.registerCommand("review", {
      description: "Review the codebase: /review [path]. Findings shown only with verified evidence.",
      handler: async (args, ctx) => {
        if (!taskRunner) {
          ctx.ui.notify("cedia: Task runner not available.", "error");
          return;
        }
        const target = (args ?? "").trim() || ".";
        ctx.ui.notify("cedia: starting review…", "info");
        const started = taskRunner.start(
          { description: "review codebase", prompt: `${REVIEW_PROMPT}\n\nReview the codebase at ${target}. Report findings with evidence.`, subagent_type: "general-purpose", run_in_background: false } as any,
          ctx,
        );
        const record = await taskRunner.wait(started.agent.id);
        const text = record.finalText ?? "";
        const findings = parseFindings(text);
        const verified = findings.map((f) => verifyFinding(f, ctx.cwd));
        const report = formatFindings(verified);
        ctx.ui.notify(report, "info");
      },
    });
    pi.registerCommand("checkpoint", {
      description: "Create a checkpoint: /checkpoint [message]",
      handler: async (args, ctx) => {
        if (!cpDir) {
          try { cpDir = initCheckpoint(ctx.cwd, ctx.sessionManager.getSessionId()); } catch (e) {
            ctx.ui.notify(`cedia: checkpoint init failed: ${e instanceof Error ? e.message : String(e)}`, "error");
            return;
          }
        }
        const msg = (args ?? "").trim() || `checkpoint ${new Date().toISOString()}`;
        const ok = createCheckpoint(cpDir, ctx.cwd, msg);
        ctx.ui.notify(ok ? `cedia: checkpoint created (${msg})` : "cedia: checkpoint failed (nothing to commit?)", ok ? "info" : "warning");
      },
    });
    pi.registerCommand("undo", {
      description: "Undo to the last checkpoint",
      handler: async (_args, ctx) => {
        if (!cpDir) {
          ctx.ui.notify("cedia: no checkpoint directory.", "error");
          return;
        }
        const ok = undoCheckpoint(cpDir, ctx.cwd);
        ctx.ui.notify(ok ? "cedia: undone to previous checkpoint." : "cedia: nothing to undo.", ok ? "info" : "warning");
      },
    });

    pi.registerCommand("plan", {
      description: "Read-only plan mode: /plan on | off | status",
      handler: async (args, ctx) => {
        const trimmed = (args ?? "").trim().toLowerCase();
        if (trimmed === "on") { planMode = true; ctx.ui.notify("cedia: plan mode on (read-only).", "info"); return; }
        if (trimmed === "off") { planMode = false; ctx.ui.notify("cedia: plan mode off.", "info"); return; }
        ctx.ui.notify(`cedia: plan mode ${planMode ? "on" : "off"}.`, "info");
      },
    });

    pi.registerCommand("sandbox", {
      description: "Toggle sandbox: /sandbox on | off | status",
      handler: async (args, ctx) => {
        const trimmed = (args ?? "").trim().toLowerCase();
        if (trimmed === "on") { sandboxConfig.enabled = true; ctx.ui.notify("cedia: sandbox on.", "info"); return; }
        if (trimmed === "off") { sandboxConfig.enabled = false; ctx.ui.notify("cedia: sandbox off.", "info"); return; }
        ctx.ui.notify(`cedia: sandbox ${sandboxConfig.enabled ? "on" : "off"}.`, "info");
      },
    });

    const settings = defaultSettings(() => Number(pi.getFlag(DEPTH_FLAG)) || 0);
    const runner = new AgentRunner(pi, settings);
    taskRunner = runner;
    if ((Number(pi.getFlag(DEPTH_FLAG)) || 0) < 3) registerAgentTools(pi, runner);
    const onExit = () => runner.signalAll();
    process.on("exit", onExit);
    pi.on("session_start", (_event, ctx) => runner.restore(ctx.sessionManager.getEntries()));
    pi.on("session_shutdown", async () => {
      process.off("exit", onExit);
      await runner.stopAll();
    });
  };
}

function definedHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  return headers && Object.fromEntries(Object.entries(headers).filter((e): e is [string, string] => e[1] !== null));
}

function readDay(file: string): RequestRecord[] {
  try {
    return parseRecords(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function lastAssistantText(messages: readonly { role: string; content: unknown }[]): string {
  const last = messages.findLast((m) => m.role === "assistant");
  if (!last || !Array.isArray(last.content)) return "";
  return last.content.flatMap((block: { type?: string; text?: string }) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}
