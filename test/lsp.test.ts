import { describe, expect, test } from "vitest";
import { formatDiagnostics } from "../src/lsp.ts";

describe("lsp", () => {
  test("formatDiagnostics handles empty", () => {
    const result = formatDiagnostics({ diagnostics: [], server: "rust-analyzer" });
    expect(result).toContain("No diagnostics");
  });

  test("formatDiagnostics formats diagnostics", () => {
    const result = formatDiagnostics({
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "unused variable" }],
      server: "rust-analyzer",
    });
    expect(result).toContain("error");
    expect(result).toContain("unused variable");
  });
});