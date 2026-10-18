import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export interface Finding {
  description: string;
  evidence: string;
  type: "file" | "command";
}

export interface VerifiedFinding extends Finding {
  verified: boolean;
  evidenceOutput: string;
}

export const REVIEW_PROMPT = `You are a code reviewer. Review the codebase for bugs, issues, and potential problems.

For each finding, provide concrete evidence that can be rerun:
- A file path and line number (e.g., src/foo.ts:42)
- A command that reproduces the issue (e.g., npm test)

Format each finding as:
FINDING: <description>
EVIDENCE: file <path>:<line>
or
FINDING: <description>
EVIDENCE: command <command>

Only report findings with concrete, verifiable evidence. Do not report speculation or style preferences.`;

export function parseFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  let current: Partial<Finding> = {};
  for (const line of lines) {
    const findingMatch = line.match(/^FINDING:\s*(.+)/i);
    if (findingMatch) {
      if (current.description && current.evidence) {
        findings.push(current as Finding);
      }
      current = { description: findingMatch[1].trim() };
      continue;
    }
    const evidenceMatch = line.match(/^EVIDENCE:\s*(.+)/i);
    if (evidenceMatch && current.description) {
      const ev = evidenceMatch[1].trim();
      if (ev.startsWith("file ")) {
        current.evidence = ev.slice(5).trim();
        current.type = "file";
      } else if (ev.startsWith("command ")) {
        current.evidence = ev.slice(8).trim();
        current.type = "command";
      } else {
        current.evidence = ev;
        current.type = ev.includes(":") && !ev.includes(" ") ? "file" : "command";
      }
    }
  }
  if (current.description && current.evidence && current.type) {
    findings.push(current as Finding);
  }
  return findings;
}

export function verifyFinding(finding: Finding, cwd: string): VerifiedFinding {
  if (finding.type === "file") {
    const [path, lineStr] = finding.evidence.split(":");
    const lineNum = parseInt(lineStr, 10);
    const fullPath = path.startsWith("/") ? path : `${cwd}/${path}`;
    if (!existsSync(fullPath)) {
      return { ...finding, verified: false, evidenceOutput: `file not found: ${path}` };
    }
    try {
      const content = readFileSync(fullPath, "utf8");
      const lines = content.split("\n");
      if (lineNum < 1 || lineNum > lines.length) {
        return { ...finding, verified: false, evidenceOutput: `line ${lineNum} out of range (file has ${lines.length} lines)` };
      }
      return { ...finding, verified: true, evidenceOutput: lines[lineNum - 1] };
    } catch (e) {
      return { ...finding, verified: false, evidenceOutput: `read error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // command
  try {
    const output = execSync(finding.evidence, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    return { ...finding, verified: false, evidenceOutput: `command exited 0 (no failure reproduced): ${output.slice(0, 200)}` };
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() ?? "";
    const stdout = e?.stdout?.toString?.() ?? "";
    const code = e?.status ?? 1;
    return { ...finding, verified: true, evidenceOutput: `exit ${code}: ${(stderr || stdout).slice(0, 300)}` };
  }
}

export function formatFindings(findings: VerifiedFinding[]): string {
  if (findings.length === 0) return "No findings.";
  const verified = findings.filter((f) => f.verified);
  const unverified = findings.filter((f) => !f.verified);
  const lines: string[] = [];
  if (verified.length) {
    lines.push(`**Verified findings (${verified.length}):**`);
    for (const f of verified) {
      lines.push(`- ${f.description}`);
      lines.push(`  Evidence: \`${f.evidence}\` → ${f.evidenceOutput.slice(0, 100)}`);
    }
  }
  if (unverified.length) {
    lines.push(`\n**Unverified (${unverified.length}):**`);
    for (const f of unverified) {
      lines.push(`- ${f.description} (${f.evidenceOutput})`);
    }
  }
  return lines.join("\n");
}