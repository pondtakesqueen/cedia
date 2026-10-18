import { fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCedia } from "../src/index.ts";

test("Task tool is registered and exposed to the model", async () => {
  const faux = fauxProvider({ models: [{ id: "faux-priced" }] });
  const cwd = mkdtempSync(join(tmpdir(), "cedia-task-e2e-"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: mkdtempSync(join(tmpdir(), "cedia-agent-")),
    noExtensions: true,
    extensionFactories: [(pi) => pi.registerProvider(faux.provider), createCedia({ telemetryDir: mkdtempSync(join(tmpdir(), "cedia-tel-")) })],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, resourceLoader, sessionManager: SessionManager.inMemory(), model: faux.getModel(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 1 } } as any),
  });
  const toolNames = session.getActiveToolNames();
  expect(toolNames).toContain("Task");
  expect(toolNames).toContain("send_message");
  expect(toolNames).toContain("list_agents");
  expect(toolNames).toContain("stop_agent");
  session.dispose();
});

// Depth exclusion (MAX_SPAWN_DEPTH = 3) is handled by agent-tools.ts via
// --exclude-tools Task; verified manually by running cedia at depth 3.