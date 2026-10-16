import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCedia } from "../src/index.ts";
import { parseRecords } from "../src/telemetry.ts";

async function run(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ models: [{ id: "faux-priced" }] });
  const telemetryDir = mkdtempSync(join(tmpdir(), "cedia-telemetry-"));
  faux.setResponses(responses);
  const cwd = mkdtempSync(join(tmpdir(), "cedia-e2e-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: mkdtempSync(join(tmpdir(), "cedia-agent-")),
    noExtensions: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), createCedia({ telemetryDir })],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, resourceLoader, sessionManager: SessionManager.inMemory(), model: faux.getModel() });
  await session.prompt("fix it");
  await session.waitForIdle();
  const custom = (type: string) =>
    session.messages.filter((m: any) => m.role === "custom" && m.customType === type).map((m: any) => String(m.content));
  const toolResults = session.messages
    .filter((m: any) => m.role === "toolResult")
    .map((m: any) => m.content.map((c: any) => c.text ?? "").join(""));
  session.dispose();
  const telemetry = readdirSync(telemetryDir).flatMap((f) => parseRecords(readFileSync(join(telemetryDir, f), "utf8")));
  return { calls: faux.state.callCount, nudges: custom("cedia.claim-check"), receipts: custom("cedia.receipt"), toolResults, telemetry };
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
