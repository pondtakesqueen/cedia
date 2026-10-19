import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface RequestRecord {
  ts: string;
  session: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  ms: number;
  ttftMs?: number;
  stopReason: string;
}

export interface Totals {
  costUsd: number;
  /** cacheRead / (input + cacheRead + cacheWrite); undefined before any input. */
  cacheHit: number | undefined;
}

export function toRecord(message: AssistantMessage, session: string, ms: number, ttftMs: number | undefined, now: Date): RequestRecord {
  const u = message.usage;
  return {
    ts: now.toISOString(),
    session,
    provider: message.provider,
    model: message.model,
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    costUsd: u.cost.total,
    ms,
    ttftMs,
    stopReason: message.stopReason,
  };
}

export function totals(records: readonly RequestRecord[]): Totals {
  let costUsd = 0;
  let cached = 0;
  let prompt = 0;
  for (const r of records) {
    costUsd += r.costUsd;
    cached += r.cacheRead;
    prompt += r.input + r.cacheRead + r.cacheWrite;
  }
  return { costUsd, cacheHit: prompt > 0 ? cached / prompt : undefined };
}

export function parseRecords(jsonl: string): RequestRecord[] {
  return jsonl.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as RequestRecord];
    } catch {
      return [];
    }
  });
}

export function statusLine(session: Totals, today: Totals, budgetUsd: number, model?: string): string {
  const cache = session.cacheHit === undefined ? "cache –" : `cache ${Math.round(session.cacheHit * 100)}%`;
  const over = today.costUsd >= budgetUsd ? ` (over $${budgetUsd})` : "";
  const modelPart = model ? ` · ${model}` : "";
  return `$${session.costUsd.toFixed(2)} session · $${today.costUsd.toFixed(2)} today${over} · ${cache}${modelPart}`;
}

export function crossedBudget(beforeUsd: number, afterUsd: number, budgetUsd: number): boolean {
  return beforeUsd < budgetUsd && afterUsd >= budgetUsd;
}

/** Local calendar day, so the daily budget resets at the user's midnight. */
export function dayFile(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.jsonl`;
}
