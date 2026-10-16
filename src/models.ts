export interface Target {
  provider: string;
  id: string;
  thinkingLevel: "low" | "medium" | "high" | "xhigh";
}

export const SMALL: Target = { provider: "anthropic", id: "claude-haiku-5-5", thinkingLevel: "low" };
export const LARGE: Target = { provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "medium" };

/** Every model name the original pstack passes, mapped to what cedia runs instead. */
export const PSTACK_MODELS: Record<string, Target> = {
  "grok-4.7-xhigh-fast": LARGE,
  "grok-4.7-medium-fast": LARGE,
  "claude-opus-5-5-xhigh": LARGE,
  "claude-opus-5-5-medium": LARGE,
  "claude-opus-5-5-max": LARGE,
};

/** `cedia/auto` on a user turn: the selected thinking level is the switch, `low` meaning small work. */
export function autoTarget(thinkingLevel: string): Target {
  return thinkingLevel === "low" ? SMALL : LARGE;
}
