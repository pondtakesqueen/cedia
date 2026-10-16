import { type AssistantMessage, StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateReason } from "./gate.ts";
import { asksForAutonomy, continuation, isSilentToolStep, openTodos, STATUS_REMINDER, type Todo } from "./loop.ts";
import { crossedBudget, dayFile, parseRecords, type RequestRecord, statusLine, toRecord, totals } from "./telemetry.ts";
import { claimNudge, detectClaims, emptyLedger, ledgerStatus, markInput, receipt, recordToolResult } from "./trust.ts";

const MAX_CLAIM_NUDGES_PER_INPUT = 1;
const MAX_CONTINUATIONS_PER_INPUT = 2;
const MAX_STATUS_REMINDERS_PER_INPUT = 2;
const SILENT_STEPS_BEFORE_REMINDER = 5;

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

    pi.registerCommand("receipt", {
      description: "Show what cedia recorded since your last message",
      handler: async (_args, ctx) => {
        ctx.ui.notify(receipt(ledgerStatus(ledger)) ?? "Nothing changed and no checks ran since your last message.", "info");
      },
    });
  };
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
