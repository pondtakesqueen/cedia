import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createCedia } from "../src/index.ts";

const savedKey = process.env.ANTHROPIC_API_KEY;
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "faux-only";
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

async function dispatched(selectId: string, thinkingLevel: "low" | "medium") {
  const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-haiku-5-5", reasoning: true }, { id: "claude-opus-5-5", reasoning: true }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("ok")),
  ]);
  const cwd = mkdtempSync(join(tmpdir(), "cedia-models-"));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: mkdtempSync(join(tmpdir(), "cedia-agent-")),
    noExtensions: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), createCedia({ telemetryDir: mkdtempSync(join(tmpdir(), "cedia-t-")) })],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, resourceLoader, sessionManager: SessionManager.inMemory(), model: faux.getModel() });
  await session.bindExtensions?.({} as any);
  const virtual = session.modelRuntime.getModel("cedia", selectId);
  if (!virtual) throw new Error(`cedia/${selectId} is not registered`);
  await session.setModel(virtual);
  session.setThinkingLevel(thinkingLevel);
  await session.prompt("go");
  await session.waitForIdle();
  const models = session.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.errorMessage ? `ERR ${m.errorMessage}` : `${m.model}@${m.thinkingLevel}`);
  session.dispose();
  return models;
}

test("cedia/auto at low routes the whole turn to Haiku low", async () => {
  expect(await dispatched("auto", "low")).toEqual(["claude-haiku-5-5@low", "claude-haiku-5-5@low"]);
});

test("cedia/auto at medium routes the whole turn to Opus medium", async () => {
  expect(await dispatched("auto", "medium")).toEqual(["claude-opus-5-5@medium", "claude-opus-5-5@medium"]);
});

test("a pstack model name dispatches to Opus medium", async () => {
  expect(await dispatched("grok-4.7-xhigh-fast", "medium")).toEqual(["claude-opus-5-5@medium", "claude-opus-5-5@medium"]);
});
