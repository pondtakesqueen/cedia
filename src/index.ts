import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gateReason } from "./gate.ts";
import { claimNudge, detectClaims, emptyLedger, ledgerStatus, markInput, receipt, recordToolResult } from "./trust.ts";

const MAX_CLAIM_NUDGES_PER_INPUT = 1;

export default function cedia(pi: ExtensionAPI): void {
  const ledger = emptyLedger();
  let nudges = 0;

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
}

function lastAssistantText(messages: readonly { role: string; content: unknown }[]): string {
  const last = messages.findLast((m) => m.role === "assistant");
  if (!last || !Array.isArray(last.content)) return "";
  return last.content.flatMap((block: { type?: string; text?: string }) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}
