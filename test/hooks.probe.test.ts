import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const hooks = ["input", "before_agent_start", "tool_result", "turn_end", "agent_before_settle", "session_before_compact"] as const;

test("pi 1.3.0 fires the hooks cedia's M0 depends on", async () => {
  const fired = new Set<string>();
  const faux = fauxProvider();
  let continued = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo probe" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("first")),
    fauxAssistantMessage(fauxText("second")),
    fauxAssistantMessage(fauxText("summary")),
    fauxAssistantMessage(fauxText("prefix summary")),
  ]);

  const cwd = mkdtempSync(join(tmpdir(), "cedia-probe-"));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: mkdtempSync(join(tmpdir(), "cedia-agent-")),
    noExtensions: true,
    extensionFactories: [
      (pi) => {
        pi.registerProvider(faux.provider);
        for (const name of hooks) pi.on(name as any, () => void fired.add(name));
        pi.on("agent_before_settle", () => {
          fired.add("agent_before_settle");
          if (continued) return;
          continued = true;
          return { continue: true, entries: [{ type: "custom_message", customType: "cedia.continue", content: "continue", display: false }] } as any;
        });
      },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({ cwd, resourceLoader, sessionManager: SessionManager.inMemory(), model: faux.getModel(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 1 } } as any),
  });
  try {
    await session.bindExtensions?.({} as any);
    await session.prompt("hello");
    await session.waitForIdle();
    expect(faux.state.callCount, "continue: true triggered one more model request").toBe(3);
    expect(session.getLastAssistantText()).toBe("second");
    await session.compact();
    for (const name of hooks) {
      expect(fired, `${name} fired`).toContain(name);
    }
  } finally {
    session.dispose();
  }
});
