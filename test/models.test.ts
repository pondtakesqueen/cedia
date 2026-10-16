import { expect, test } from "vitest";
import { autoTarget, LARGE, PSTACK_MODELS, SMALL } from "../src/models.ts";

test("low selects Haiku low; anything else selects Opus medium", () => {
  expect(autoTarget("low")).toEqual(SMALL);
  expect(autoTarget("medium")).toEqual(LARGE);
  expect(SMALL).toEqual({ provider: "anthropic", id: "claude-haiku-5-5", thinkingLevel: "low" });
  expect(LARGE).toEqual({ provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "medium" });
});

test("every model name the original pstack uses has a mapping", () => {
  expect(Object.keys(PSTACK_MODELS).sort()).toEqual(
    ["claude-opus-5-5-max", "claude-opus-5-5-medium", "claude-opus-5-5-xhigh", "grok-4.7-medium-fast", "grok-4.7-xhigh-fast"],
  );
});
