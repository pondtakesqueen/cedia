import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, type ExtensionUIContext, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCedia } from "../src/index.ts";
import { parseRecords } from "../src/telemetry.ts";

async function run(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], after?: (session: AgentSession) => Promise<void>, ui?: Partial<ExtensionUIContext>) {
  const faux = fauxProvider({ models: [{ id: "faux-priced" }] });
  const telemetryDir = mkdtempSync(join(tmpdir(), "cedia-telemetry-"));
  faux.setResponses(responses);
  const cwd = mkdtempSync(join(tmpdir(), "cedia-e2e-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  mkdirSync(join(cwd, "skills/tdd"), { recursive: true });
  writeFileSync(join(cwd, "skills/tdd/SKILL.md"), "# tdd");
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: mkdtempSync(join(tmpdir(), "cedia-agent-")),
    noExtensions: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), createCedia({ telemetryDir })],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, resourceLoader, sessionManager: SessionManager.inMemory(), model: faux.getModel(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 1 } } as any),
  });
  if (ui) await session.bindExtensions({ mode: "rpc", uiContext: scriptedUI(ui) });
  await session.prompt("fix it");
  await session.waitForIdle();
  await after?.(session);
  const custom = (type: string) =>
    session.messages.filter((m: any) => m.role === "custom" && m.customType === type).map((m: any) => String(m.content));
  const toolResults = session.messages
    .filter((m: any) => m.role === "toolResult")
    .map((m: any) => m.content.map((c: any) => c.text ?? "").join(""));
  session.dispose();
  const telemetry = readdirSync(telemetryDir).flatMap((f) => parseRecords(readFileSync(join(telemetryDir, f), "utf8")));
  return { calls: faux.state.callCount, continues: custom("cedia.continue"), reminders: custom("cedia.status-reminder"), nudges: custom("cedia.claim-check"), receipts: custom("cedia.receipt"), toolResults, telemetry };
}

/** A UI whose dialogs answer from the script; every other UI call is a no-op. */
function scriptedUI(script: Partial<ExtensionUIContext>): ExtensionUIContext {
  return new Proxy(script, { get: (target, key) => (target as any)[key] ?? (() => undefined) }) as ExtensionUIContext;
}

const write = fauxAssistantMessage(fauxToolCall("write", { path: "a.txt", content: "x" }), { stopReason: "toolUse" });

test("claiming done after an unchecked edit gets exactly one nudge, then a receipt", async () => {
  const r = await run([write, fauxAssistantMessage(fauxText("Done, it's fixed.")), fauxAssistantMessage(fauxText("Done, it's fixed."))]);
  expect(r.calls, "one continuation, then the cap stops further nudges").toBe(3);
  expect(r.nudges).toHaveLength(1);
  expect(r.nudges[0]).toContain("a.txt");
  expect(r.receipts).toHaveLength(1);
  expect(r.receipts[0]).toContain("Unverified: `a.txt`");
});

test("an edit followed by a passing check settles with a clean receipt and no nudge", async () => {
  const check = fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }), { stopReason: "toolUse" });
  const r = await run([write, check, fauxAssistantMessage(fauxText("Done, tests pass."))]);
  expect(r.calls).toBe(3);
  expect(r.nudges).toHaveLength(0);
  expect(r.receipts[0]).toMatch(/exit 0/);
  expect(r.receipts[0]).not.toContain("Unverified");
});

test("an irreversible command is blocked when nobody can approve it", async () => {
  const push = fauxAssistantMessage(fauxToolCall("bash", { command: "git push --force origin main" }), { stopReason: "toolUse" });
  const r = await run([push, fauxAssistantMessage(fauxText("I could not push."))]);
  expect(r.toolResults).toHaveLength(1);
  expect(r.toolResults[0]).toContain("Blocked without the user's approval: force-push");
});

test("every model request is written to the day's telemetry file", async () => {
  const r = await run([write, fauxAssistantMessage(fauxText("Here is the plan."))]);
  expect(r.telemetry).toHaveLength(r.calls);
  expect(r.telemetry.every((t) => t.model === "faux-priced" && t.input + t.cacheRead > 0 && typeof t.costUsd === "number")).toBe(true);
  expect(r.telemetry[1].cacheRead, "the second request reuses the cached prefix").toBeGreaterThan(0);
});

const todo = (status: "pending" | "completed") =>
  fauxAssistantMessage(fauxToolCall("TodoWrite", { todos: [{ content: "migrate the parser", status }] }), { stopReason: "toolUse" });

test("headless runs with open todos continue at most twice", async () => {
  const r = await run([todo("pending"), ...Array.from({ length: 4 }, () => fauxAssistantMessage(fauxText("Working on it.")))]);
  expect(r.continues).toHaveLength(2);
  expect(r.continues[0]).toContain("- migrate the parser");
  expect(r.calls).toBe(4);
});

test("completed todos do not trigger a continuation", async () => {
  const r = await run([todo("completed"), fauxAssistantMessage(fauxText("All set."))]);
  expect(r.continues).toHaveLength(0);
});

test("five silent tool steps in a row get one status reminder", async () => {
  const echo = () => fauxAssistantMessage(fauxToolCall("bash", { command: "echo step" }), { stopReason: "toolUse" });
  const r = await run([...Array.from({ length: 6 }, echo), fauxAssistantMessage(fauxText("Here is where things stand."))]);
  expect(r.reminders).toHaveLength(1);
});

test("compaction asks pi's summarizer for a handoff with todos, unverified files, skills and focus", async () => {
  let summaryPrompt = "";
  const capture = (text: string) => (context: unknown) => {
    summaryPrompt += JSON.stringify(context);
    return fauxAssistantMessage(fauxText(text));
  };
  const read = fauxAssistantMessage(fauxToolCall("read", { path: "skills/tdd/SKILL.md" }), { stopReason: "toolUse" });
  await run([todo("pending"), read, write, ...Array.from({ length: 3 }, () => fauxAssistantMessage(fauxText("Paused here."))), capture("summary"), capture("prefix")], (s) =>
    s.compact("finish the migration").then(() => undefined),
  );
  expect(summaryPrompt).toContain("migrate the parser");
  expect(summaryPrompt).toContain("handoff for a fresh agent");
  expect(summaryPrompt).toContain("unverified: a.txt");
  expect(summaryPrompt).toContain("Suggested Skills");
  expect(summaryPrompt).toContain("tdd");
  expect(summaryPrompt).toContain("focus on: finish the migration");
});

test("AskQuestion in headless mode tells the model to ask in plain text", async () => {
  const ask = fauxAssistantMessage(fauxToolCall("AskQuestion", { questions: [{ question: "Which base?", options: ["pi", "omp"] }] }), { stopReason: "toolUse" });
  const r = await run([ask, fauxAssistantMessage(fauxText("Which base do you want, pi or omp?"))]);
  expect(r.toolResults[0]).toContain("No one can answer dialogs in this mode");
});

test("the cedia-tools mapping reaches the model's system prompt", async () => {
  let system = "";
  const r = await run([(context: any) => ((system = JSON.stringify(context.messages?.[0] ?? context)), fauxAssistantMessage(fauxText("ok")))]);
  expect(r.calls).toBe(1);
  expect(system).toContain("<cedia-tools>");
  expect(system).toContain("Task");
});

const forcePush = fauxAssistantMessage(fauxToolCall("bash", { command: "git push --force origin main" }), { stopReason: "toolUse" });

test("with a UI, a declined irreversible command is blocked and says the user declined", async () => {
  const asked: string[] = [];
  const r = await run([forcePush, fauxAssistantMessage(fauxText("Skipped the push."))], undefined, {
    confirm: async (_title: string, message: string) => (asked.push(message), false),
  });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("git push --force origin main");
  expect(r.toolResults[0]).toContain("The user declined: force-push");
});

test("with a UI, an approved irreversible command runs", async () => {
  const r = await run([forcePush, fauxAssistantMessage(fauxText("Pushed."))], undefined, { confirm: async () => true });
  expect(r.toolResults[0]).not.toContain("declined");
  expect(r.toolResults[0]).toContain("not a git repository");
});

test("with a UI, AskQuestion returns the chosen option and a typed Other answer", async () => {
  const ask = fauxAssistantMessage(
    fauxToolCall("AskQuestion", { questions: [{ question: "Which base?", options: ["pi", "omp"] }, { question: "Budget?", options: ["$20", "$50"] }] }),
    { stopReason: "toolUse" },
  );
  const r = await run([ask, fauxAssistantMessage(fauxText("Noted."))], undefined, {
    select: async (title: string, options: string[]) => (title === "Which base?" ? "pi" : options.at(-1)),
    input: async () => "$35",
  });
  expect(r.toolResults[0]).toBe("Which base?\n→ pi\n\nBudget?\n→ $35");
});
