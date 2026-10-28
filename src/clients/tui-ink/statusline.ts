import { spawnSync } from 'node:child_process';

export type StatusLineInput = {
  model: string;
  workspace: string;
  costUsd: number;
  contextWindow: number;
  vimMode?: string;
  permissionMode?: string;
  rateLimits?: unknown;
  worktree?: string;
};

export function buildStatusLineInput(input: StatusLineInput): string {
  return JSON.stringify(input);
}

export function runStatusLineCommand(command: string, input: StatusLineInput): string {
  try {
    const p = spawnSync(command, [], { input: buildStatusLineInput(input), encoding: 'utf8', shell: true, timeout: 2000 });
    if (p.error) return '';
    return (p.stdout ?? '').trim();
  } catch {
    return '';
  }
}
