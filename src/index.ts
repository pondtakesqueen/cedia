import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateReason } from "./gate.ts";
import { crossedBudget, dayFile, parseRecords, type RequestRecord, statusLine, toRecord, totals } from "./telemetry.ts";
import { claimNudge, detectClaims, emptyLedger, ledgerStatus, markInput, receipt, recordToolResult } from "./trust.ts";

const MAX_CLAIM_NUDGES_PER_INPUT = 1;

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
    let requestStartedAt = 0;

    pi.on("input", () => {
      markInput(ledger);
      nudges = 0;
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

    pi.on("agent_before_settle", (event) => {
      if (event.outcome !== "completed") return;
      const status = ledgerStatus(ledger);
      const nudge = nudges < MAX_CLAIM_NUDGES_PER_INPUT ? claimNudge(status, detectClaims(lastAssistantText(event.context.llmMessages))) : undefined;
      if (nudge) {
        nudges++;
        return { continue: true, entries: [{ type: "custom_message", customType: "cedia.claim-check", content: nudge, display: true }] };
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
