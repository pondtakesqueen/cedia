import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface GoalState {
  active: boolean;
  outcome: string;
  round: number;
  lastCheckIndex: number;
  startLedgerIndex: number;
}

export function emptyGoalState(): GoalState {
  return { active: false, outcome: "", round: 0, lastCheckIndex: 0, startLedgerIndex: 0 };
}

export function startGoal(state: GoalState, outcome: string, ledgerLength: number): void {
  state.active = true;
  state.outcome = outcome;
  state.round = 0;
  state.lastCheckIndex = ledgerLength;
  state.startLedgerIndex = ledgerLength;
}

export function stopGoal(state: GoalState): void {
  state.active = false;
  state.outcome = "";
  state.round = 0;
  state.lastCheckIndex = 0;
  state.startLedgerIndex = 0;
}

export function goalStatus(state: GoalState): string {
  if (!state.active) return "No active goal.";
  return `Goal: ${state.outcome} (round ${state.round}/3)`;
}

export interface VerifyResult {
  refuted: boolean;
  reason: string;
  gaps: string[];
}

const VERIFIER_SYSTEM = `You are an adversarial verifier. You have NOT seen the work being done. You only see the goal, the check result, and a summary of what changed. Your job is to try to REFUTE the claim that the goal has been met.

Rules:
- Default to refuted: true when uncertain. Only return refuted: false if you are confident the goal is met.
- Try to find gaps: missing tests, unhandled edge cases, incomplete implementation, unverified files.
- Judge from the evidence provided, not from trust.

Respond ONLY with JSON: { "refuted": boolean, "reason": "one line", "gaps": ["gap1", "gap2"] }`;

export async function verifyGoal(
  outcome: string,
  checkCommand: string | undefined,
  checkExitCode: number | undefined,
  changedFiles: string[],
  lastAssistantText: string,
  registry: ModelRegistry,
  model: Model<any> | undefined,
): Promise<VerifyResult> {
  const m = model ?? registry.find("anthropic", "claude-haiku-5-5");
  if (!m) {
    return { refuted: true, reason: "verifier unavailable: no model", gaps: ["no model available"] };
  }
  const auth = await registry.getApiKeyAndHeaders(m);
  if (!auth.ok) {
    return { refuted: true, reason: "verifier unavailable: no auth", gaps: ["no auth available"] };
  }

  const userText = [
    `Goal: ${outcome}`,
    `Check: ${checkCommand ?? "(none)"} → exit ${checkExitCode ?? "(unknown)"}`,
    `Changed files: ${changedFiles.length ? changedFiles.join(", ") : "(none)"}`,
    `Last assistant message: ${lastAssistantText.slice(0, 500)}`,
    "",
    "Is the goal met? Try to refute.",
  ].join("\n");

  const context = {
    systemPrompt: VERIFIER_SYSTEM,
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: userText }], timestamp: Date.now() },
    ],
  };

  let text = "";
  try {
    const msg = await registry.complete(m, context, { thinkingLevel: "low" });
    text = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch {
    return { refuted: true, reason: "verifier unavailable: error", gaps: ["verifier error"] };
  }

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no json");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      refuted: Boolean(parsed.refuted),
      reason: String(parsed.reason ?? ""),
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
    };
  } catch {
    return { refuted: true, reason: "verifier parse failure", gaps: ["could not parse verifier response"] };
  }
}