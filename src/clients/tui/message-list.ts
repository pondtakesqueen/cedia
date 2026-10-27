export type ToolCard = { icon: string; name: string; args: string; status: 'running' | 'success' | 'error'; exitCode?: number; durationMs?: number; diff?: { added: number; removed: number } };

const screenReader = () => process.env.CEDIA_SCREEN_READER === '1' || process.env.CEDIA_AX_SCREEN_READER === '1';

export function renderToolCard(c: ToolCard): string {
  const statusIcon = c.status === 'error' ? '✗' : c.status === 'running' ? '…' : '✓';
  const color = c.status === 'error' ? '\x1b[31m' : c.status === 'running' ? '\x1b[33m' : '\x1b[32m';
  const reset = '\x1b[0m';
  const lead = c.icon ? `${c.icon} ` : '';
  const head = `${lead}${color}${statusIcon}${reset} ${c.name} ${c.args.slice(0, 60)}`;
  const meta: string[] = [];
  if (c.diff) meta.push(`+${c.diff.added}/-${c.diff.removed}`);
  if (c.exitCode !== undefined) meta.push(`exit=${c.exitCode}`);
  if (c.durationMs !== undefined) meta.push(`${c.durationMs}ms`);
  const tail = meta.length ? `  (${meta.join(', ')})` : '';
  const line = `${head}${tail}`;
  if (screenReader()) return line;
  return `┌─ ${line} ─┐`;
}

export function renderThinking(text: string, streaming: boolean, durationMs?: number): string {
  const border = '┄';
  const label = streaming ? 'กำลังคิด…' : `คิด ${(durationMs ?? 0) / 1000}s`;
  return `${border} ${label}\n${text}\n${border}`;
}

export function renderReceipt(r: { verified: boolean; verdict?: string; turns: number; timeMs: number; costUsd: number; checks: string[]; changed: string[] }): string {
  const badge = r.verified ? '✓ verified' : '⚠ unverified';
  return `[receipt] ${badge} ${r.verdict ?? ''} turns=${r.turns} time=${r.timeMs}ms cost=$${r.costUsd.toFixed(4)} checks=${r.checks.join(',')} files=${r.changed.join(',')}`;
}

export function renderUserMessage(text: string): string {
  return `› ${text}`;
}

export function renderAssistantMessage(text: string, streaming: boolean): string {
  // Keep the full reply (CC does not truncate); only mark the streaming cursor.
  return streaming ? `${text}▌` : text;
}

export function renderSessionDivider(): string {
  return '─'.repeat(40);
}
