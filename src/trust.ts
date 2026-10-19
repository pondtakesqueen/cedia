export type LedgerEntry =
  | { kind: "change"; path: string }
  | { kind: "check"; command: string; exitCode: number };

export interface Ledger {
  entries: LedgerEntry[];
  /** Index of the first entry recorded since the latest user input. */
  inputMark: number;
}

export interface LedgerStatus {
  changed: string[];
  checks: Extract<LedgerEntry, { kind: "check" }>[];
  unverified: string[];
}

export interface Claims {
  done: boolean;
  ranCheck: boolean;
}

const CHECK_COMMAND =
  /\b((npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check|build)|npx\s+(vitest|jest|tsc|eslint)|vitest|jest|pytest|tsc|eslint|ruff|mypy|cargo\s+(test|check|clippy|build)|go\s+(test|vet|build)|make\s+(test|check|lint))\b/;

const DONE_CLAIM =
  /\b(done|fixed|completed?|all (tests|checks) pass(ed)?|tests? pass(es|ed)?|passing|works now|verified)\b|เสร็จแล้ว|เสร็จเรียบร้อย|แก้แล้ว|ผ่านแล้ว|ผ่านหมด|ใช้งานได้แล้ว/i;

const RAN_CHECK_CLAIM =
  /\b(ran|run|re-?ran) (the |all )?(tests?|checks?|lint(er)?|build|typecheck)\b|\btests? (now )?pass|รัน\s*(test|เทสต์|ทดสอบ)|ทดสอบแล้ว/i;

export function emptyLedger(): Ledger {
  return { entries: [], inputMark: 0 };
}

export function isCheckCommand(command: string): boolean {
  return CHECK_COMMAND.test(command);
}

export function markInput(ledger: Ledger): void {
  ledger.inputMark = ledger.entries.length;
}

// ponytail: bash commands that change files are not recorded as changes; upgrade when M4 shadow-git snapshots can diff the tree per tool call.
export function recordToolResult(ledger: Ledger, toolName: string, input: Record<string, unknown>, isError: boolean, exitCode: unknown): void {
  if ((toolName === "edit" || toolName === "write") && !isError && typeof input.path === "string") {
    ledger.entries.push({ kind: "change", path: input.path });
    return;
  }
  if (toolName === "bash" && typeof input.command === "string" && isCheckCommand(input.command)) {
    ledger.entries.push({ kind: "check", command: input.command, exitCode: typeof exitCode === "number" ? exitCode : isError ? 1 : 0 });
  }
}


/** Record file paths that a bash command changed (interim until M4 shadow-git). */
export function recordBashChanges(ledger: Ledger, paths: readonly string[]): void {
  for (const p of paths) {
    if (typeof p === "string" && p.trim()) ledger.entries.push({ kind: "change", path: p.trim() });
  }
}
export function ledgerStatus(ledger: Ledger): LedgerStatus {
  const recent = ledger.entries.slice(ledger.inputMark);
  const lastPass = ledger.entries.findLastIndex((e) => e.kind === "check" && e.exitCode === 0);
  const unverified = ledger.entries.slice(lastPass + 1).flatMap((e) => (e.kind === "change" ? [e.path] : []));
  return {
    changed: unique(recent.flatMap((e) => (e.kind === "change" ? [e.path] : []))),
    checks: recent.filter((e): e is Extract<LedgerEntry, { kind: "check" }> => e.kind === "check"),
    unverified: unique(unverified),
  };
}

export function detectClaims(text: string): Claims {
  return { done: DONE_CLAIM.test(text), ranCheck: RAN_CHECK_CLAIM.test(text) };
}

export function claimNudge(status: LedgerStatus, claims: Claims): string | undefined {
  if (claims.ranCheck && status.checks.length === 0) {
    return "Your last message says a check ran, but no check command ran since the user's last message. Run it now, or say plainly that it did not run.";
  }
  if (claims.done && status.unverified.length > 0) {
    return `Your last message claims the work is done, but these files changed after the last passing check: ${status.unverified.join(", ")}. Run the check that proves it, or say plainly what is unverified.`;
  }
  return undefined;
}

export function receipt(status: LedgerStatus, full = false): string | undefined {
  if (status.changed.length === 0 && status.checks.length === 0) return undefined;
  if (!full) {
    const bits = [`${status.changed.length} changed`, `${status.checks.length} checks`];
    if (status.unverified.length) bits.push(`${status.unverified.length} unverified`);
    return `**Receipt** (${bits.join(", ")}) — /receipt for detail`;
  }
  const lines = ["**Receipt** (recorded by cedia)"];
  lines.push(`- Changed: ${status.changed.length ? status.changed.map((p) => `\`${p}\``).join(", ") : "nothing"}`);
  lines.push(...status.checks.map((c) => `- Check \`${c.command}\` → exit ${c.exitCode}`));
  if (status.checks.length === 0) lines.push("- Checks: none ran");
  if (status.unverified.length) lines.push(`- Unverified: ${status.unverified.map((p) => `\`${p}\``).join(", ")}`);
  return lines.join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
