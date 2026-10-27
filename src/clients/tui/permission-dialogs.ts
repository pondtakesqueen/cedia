export function bashDialog(cmd: string, timeout?: number, desc?: string): string {
  const lines = [`┌─ Bash ─┐`, `│ ${cmd}`, ...(timeout ? [`│ timeout ${timeout}ms`] : []), ...(desc ? [`│ ${desc}`] : []), `│ [Allow] [Deny] [Ask]`, `└────────┘`];
  return lines.join('\n');
}
export function editDialog(path: string, oldText: string, newText: string): string {
  return [`┌─ Edit ${path} ─┐`, `│ - ${oldText}`, `│ + ${newText}`, `│ [Allow] [Deny]`, `└${'─'.repeat(Math.max(4, path.length + 4))}┘`].join('\n');
}
export function webFetchDialog(url: string, prompt?: string): string {
  return [`┌─ WebFetch ─┐`, `│ ${url}`, ...(prompt ? [`│ prompt: ${prompt}`] : []), `│ [Allow] [Deny]`, `└───────────┘`].join('\n');
}
export function askUserDialog(question: string, options?: string[]): string {
  return [question, ...(options ? options.map((o, i) => `${i + 1}. ${o}`) : [])].join('\n');
}

export function notebookDialog(path: string, cell?: number): string {
  return [`┌─ NotebookEdit ─┐`, `│ ${path}${cell !== undefined ? ` (cell ${cell})` : ''}`, `│ [Allow] [Deny] [Ask]`, `└───────────────┘`].join('\n');
}

export function skillDialog(skill: string, args?: string): string {
  return [`┌─ Skill ─┐`, `│ ${skill}${args ? ` ${args}` : ''}`, `│ [Allow] [Deny]`, `└─────────┘`].join('\n');
}

export function planModeDialog(plan: string): string {
  return [`┌─ Plan Mode ─┐`, `│ ${plan.slice(0, 200)}${plan.length > 200 ? '…' : ''}`, `│ [Approve] [Deny] [Revise]`, `└────────────┘`].join('\n');
}

export function fallbackDialog(tool: string, reason: string): string {
  return [`┌─ Permission (fallback) ─┐`, `│ ${tool}: ${reason}`, `│ [Allow] [Deny]`, `└────────────────────────┘`].join('\n');
}
