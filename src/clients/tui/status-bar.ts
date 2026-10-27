export type StatusBarState = { model: string; permission: string; branch?: string; dirtyCount?: number; thread?: string; contextPct: number; spendUsd: number; lastRate?: number; cols: number };

export function renderStatusBar(s: StatusBarState): string {
  const cols = s.cols ?? 100;
  const parts: string[] = [s.model, s.permission];
  const compact = cols < 80;
  if (!compact && s.branch) parts.push(`${s.branch}${s.dirtyCount ? ` (${s.dirtyCount})` : ''}`);
  if (s.thread) parts.push(s.thread);
  const ctxColor = s.contextPct >= 90 ? 'RED' : s.contextPct >= 75 ? 'AMBER' : 'OK';
  parts.push(`ctx ${s.contextPct}% [${ctxColor}]`);
  if (!compact) parts.push(`$${s.spendUsd.toFixed(2)}`);
  if (s.lastRate !== undefined) parts.push(`${s.lastRate} tok/s`);
  return parts.join(' | ');
}
