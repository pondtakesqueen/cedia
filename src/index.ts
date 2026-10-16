import { type AssistantMessage, StringEnum } from "@earendil-works/pi-ai";
import { compact, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatAnswers, NO_UI_ANSWER, OTHER } from "./ask.ts";
import { gateReason } from "./gate.ts";
import { handoffInstructions, skillName } from "./handoff.ts";
import { autoTarget, PSTACK_MODELS, type Target } from "./models.ts";
import { asksForAutonomy, continuation, isSilentToolStep, openTodos, STATUS_REMINDER, type Todo } from "./loop.ts";
import { crossedBudget, dayFile, parseRecords, type RequestRecord, statusLine, toRecord, totals } from "./telemetry.ts";
import { claimNudge, detectClaims, emptyLedger, ledgerStatus, markInput, receipt, recordToolResult } from "./trust.ts";

const MAX_CLAIM_NUDGES_PER_INPUT = 1;
const MAX_CONTINUATIONS_PER_INPUT = 2;
const MAX_STATUS_REMINDERS_PER_INPUT = 2;
const SILENT_STEPS_BEFORE_REMINDER = 5;

const AskParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "One decision the user must make, as a complete question" }),
      options: Type.Array(Type.String(), { minItems: 2, maxItems: 4, description: "Short, mutually exclusive choices; put a recommended one first" }),
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
    const ledger = emptyLedger();
    const sessionRecords: RequestRecord[] = [];
    let nudges = 0;
    let continuations = 0;
    let reminders = 0;
    let silentSteps = 0;
    let autonomous = false;
    let todos: Todo[] = [];
    const skills = new Set<string>();
    let requestStartedAt = 0;

    pi.on("input", (event) => {
      markInput(ledger);
      nudges = continuations = reminders = silentSteps = 0;
      autonomous = asksForAutonomy(event.text);
    });

    const restoreTodos = (ctx: ExtensionContext) => {
      todos = [];
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "TodoWrite") {
          todos = (entry.message.details as { todos?: Todo[] } | undefined)?.todos ?? todos;
        }
      }
    };
    pi.on("session_start", (_event, ctx) => restoreTodos(ctx));
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
          const choice = await ctx.ui.select(q.question, [...q.options, OTHER]);
          answers.push(choice === OTHER ? await ctx.ui.input(q.question) : choice);
        }
        return { content: [{ type: "text", text: formatAnswers(params.questions, answers) }], details: { answered: true, answers } };
      },
    });

    pi.on("turn_end", () => {
      if (silentSteps < SILENT_STEPS_BEFORE_REMINDER || reminders >= MAX_STATUS_REMINDERS_PER_INPUT) return;
      silentSteps = 0;
      reminders++;
      return { entries: [{ type: "custom_message", customType: "cedia.status-reminder", content: STATUS_REMINDER, display: false }] };
    });

    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
      const reason = gateReason(event.input.command);
      if (!reason) return;
      if (ctx.hasUI && (await ctx.ui.confirm("cedia: confirm irreversible command", `${event.input.command}\n\n${reason}`))) return;
      return {
        block: true,
        reason: ctx.hasUI
          ? `The user declined: ${reason}. Do not retry it; continue without it or ask the user how to proceed.`
          : `Blocked without the user's approval: ${reason}. Nobody can approve it in this mode, so report it as a step the user must run.`,
      };
    });

    pi.on("tool_result", (event) => {
      if (event.toolName === "read" && typeof event.input.path === "string") {
        const skill = skillName(event.input.path);
        if (skill) skills.add(skill);
      }
      const exitCode = (event.structuredContent as { exit_code?: unknown } | undefined)?.exit_code;
      recordToolResult(ledger, event.toolName, event.input, event.isError, exitCode);
    });

    pi.on("message_start", (event) => {
      if (event.message.role === "assistant") requestStartedAt = Date.now();
    });

    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "assistant") return;
      silentSteps = isSilentToolStep(event.message.content) ? silentSteps + 1 : 0;
      const at = now();
      const record = toRecord(event.message as AssistantMessage, ctx.sessionManager.getSessionId(), Date.now() - requestStartedAt, at);
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

    pi.on("agent_before_settle", (event, ctx) => {
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
      const text = receipt(status);
      if (text) return { entries: [{ type: "custom_message", customType: "cedia.receipt", content: text, display: true }] };
    });

    // ponytail: summarizes with the session's model directly, skipping pi's virtual-model routing for summaries; upgrade when cedia/auto routes summaries elsewhere.
    pi.on("session_before_compact", async (event, ctx) => {
      if (!ctx.model) return;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) return;
      const instructions = handoffInstructions({
        openTodos: openTodos(todos),
        unverified: ledgerStatus(ledger).unverified,
        skills: [...skills],
        focus: event.customInstructions,
      });
      const stream = (model: Parameters<typeof ctx.modelRegistry.streamSimple>[0], context: Parameters<typeof ctx.modelRegistry.streamSimple>[1], opts?: Parameters<typeof ctx.modelRegistry.streamSimple>[2]) =>
        ctx.modelRegistry.streamSimple(model, context, opts);
      try {
        return { compaction: await compact(event.preparation, ctx.model, auth.apiKey, definedHeaders(auth.headers), instructions, event.signal, ctx.thinkingLevel, stream) };
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
