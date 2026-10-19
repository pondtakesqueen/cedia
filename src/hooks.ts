import { execSync } from "node:child_process";

export type HookEvent = "pre_tool" | "post_tool";
export type HookDecision = "allow" | "deny" | "ask";

export interface HookRule {
  event: HookEvent;
  matcher: RegExp;
  command: string;
  timeoutMs?: number;
}

export interface HookResult {
  decision: HookDecision;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 10000;

function parseRule(raw: string): HookRule | undefined {
  const first = raw.indexOf(":");
  const second = raw.indexOf(":", first + 1);
  if (first === -1 || second === -1) return undefined;
  const event = raw.slice(0, first).trim();
  const pattern = raw.slice(first + 1, second).trim();
  const command = raw.slice(second + 1).trim();
  if ((event !== "pre_tool" && event !== "post_tool") || !pattern || !command) return undefined;
  try {
    return { event, matcher: new RegExp(pattern), command };
  } catch {
    return undefined;
  }
}

export function loadHookRules(env: NodeJS.ProcessEnv = process.env): HookRule[] {
  const raw = env.CEDIA_HOOKS ?? "";
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      const rule = parseRule(line);
      return rule ? [rule] : [];
    });
}

export function runHook(rule: HookRule, payload: { tool: string; input: string; cwd: string }): HookResult {
  const input = JSON.stringify({ tool: payload.tool, input: payload.input });
  try {
    const out = execSync(rule.command, {
      cwd: payload.cwd,
      input,
      encoding: "utf8",
      timeout: rule.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "ignore"],
      shell: "/bin/sh",
    }).trim();
    if (out.startsWith("deny")) return { decision: "deny", reason: out.slice(4).trim() || "denied by hook" };
    if (out.startsWith("ask")) return { decision: "ask", reason: out.slice(3).trim() || "hook requests approval" };
    return { decision: "allow" };
  } catch (e) {
    const failed = e as { status?: number; message?: string };
    if (typeof failed.status === "number") {
      return { decision: "deny", reason: `hook exited ${failed.status}` };
    }
    return { decision: "allow" };
  }
}

export function matchHooks(rules: readonly HookRule[], event: HookEvent, toolName: string): HookRule[] {
  return rules.filter((r) => r.event === event && r.matcher.test(toolName));
}

export type ApprovalPolicy = "ask" | "auto" | "deny";
export type SandboxMode = "off" | "read-only" | "full";

export function parseApprovalPolicy(value: string | undefined): ApprovalPolicy {
  if (value === "auto" || value === "deny") return value;
  return "ask";
}

export function parseSandboxMode(value: string | undefined): SandboxMode {
  if (value === "full" || value === "read-only") return value;
  return "off";
}

export function approvalFor(policy: ApprovalPolicy, hasUI: boolean): "confirm" | "block" | "allow" {
  if (policy === "deny") return "block";
  if (policy === "auto") return "allow";
  return hasUI ? "confirm" : "block";
}
