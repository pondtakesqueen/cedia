import type { Todo } from "./loop.ts";
export interface HandoffInputs {
  openTodos: readonly Todo[];
  unverified: readonly string[];
  skills: readonly string[];
  recentFiles?: readonly string[];
  focus?: string;
}

/** Extra instructions appended to pi's own checkpoint summary prompt, so the summary works as a handoff. */
export function handoffInstructions(h: HandoffInputs): string {
  const lines = [
    "Write the summary as a handoff for a fresh agent that has not seen this conversation.",
    "- Reference specs, plans, issues, commits and diffs by path or URL; do not copy their contents.",
    "- Never include secrets, API keys, tokens, passwords or personal data; write [redacted] instead.",
  ];
  if (h.openTodos.length) lines.push(`- Under Next Steps, include these open todos verbatim: ${h.openTodos.map((t) => `"${t.content}" (${t.status})`).join("; ")}.`);
  if (h.unverified.length) lines.push(`- Under Critical Context, state that these files changed after the last passing check and are unverified: ${h.unverified.join(", ")}.`);
  if (h.recentFiles?.length) lines.push(`- Under Critical Context, note these recently-read files the next agent should re-read before editing: ${h.recentFiles.join(", ")}.`);
  if (h.skills.length) lines.push(`- End with a "## Suggested Skills" section naming the skills the next agent should load: ${h.skills.join(", ")}.`);
  if (h.focus?.trim()) lines.push(`- The next session will focus on: ${h.focus.trim()}. Prioritize what it needs.`);
  return lines.join("\n");
}

export function skillName(readPath: string): string | undefined {
  const match = /([^/\\]+)[/\\]SKILL\.md$/.exec(readPath);
  return match?.[1];
}
