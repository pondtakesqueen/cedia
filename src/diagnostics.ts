import { execSync } from "node:child_process";
import { extname } from "node:path";

export interface DiagnosticResult {
  command: string;
  output: string;
  exitCode: number;
}

export function diagnose(filePath: string, cwd: string): DiagnosticResult | null {
  const ext = extname(filePath).toLowerCase();
  const commands: string[] = [];

  if (ext === ".ts" || ext === ".tsx") {
    commands.push("npx tsc --noEmit 2>&1 || true");
  }
  if (ext === ".js" || ext === ".jsx" || ext === ".ts" || ext === ".tsx" || ext === ".mjs" || ext === ".cjs") {
    commands.push(`npx eslint --no-eslintrc --rule '{"no-undef":"error"}' ${JSON.stringify(filePath)} 2>&1 || true`);
  }

  for (const cmd of commands) {
    try {
      const output = execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 });
      if (output.trim()) {
        return { command: cmd, output: output.trim().slice(0, 2000), exitCode: 0 };
      }
    } catch (e: any) {
      const stderr = e?.stderr?.toString?.() ?? "";
      const stdout = e?.stdout?.toString?.() ?? "";
      const output = (stderr || stdout || e?.message || "").trim().slice(0, 2000);
      if (output) {
        return { command: cmd, output, exitCode: e?.status ?? 1 };
      }
    }
  }
  return null;
}