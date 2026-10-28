import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cediaHome } from '../../core/config.ts';
import { projectKey } from '../../core/session/log.ts';
import { isUsageEvent, readEventsLenient, usageReport } from '../../core/session/usage.ts';

export type ProjectUsageSummary = {
  models: { model: string; costUsd: number; requests: number }[];
  sessions: number;
  requests: number;
  tokens: { in: number; cache: number; out: number };
  handoffs: number;
};

/** Per-model spend for the Settings Usage tab, from this project's recent session logs. */
export function loadProjectUsage(cwd: string, home = cediaHome(), limit = 20): ProjectUsageSummary | null {
  try {
    const dir = join(home, 'sessions', projectKey(cwd));
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ p: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, limit);
    if (!files.length) return null;
    const sessions = files.map((f) => ({
      id: f.p.split('/').pop()!.replace(/\.jsonl$/, ''),
      events: readEventsLenient(readFileSync(f.p, 'utf8')).filter(isUsageEvent),
    }));
    const report = usageReport(sessions, {});
    return {
      models: report.models,
      sessions: report.sessions,
      requests: report.requests,
      tokens: { in: report.tokens.input, cache: report.tokens.cacheRead, out: report.tokens.output },
      handoffs: report.handoffs,
    };
  } catch {
    return null;
  }
}
