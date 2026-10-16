export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

const AUTONOMY_REQUEST = /\b(run until (it'?s )?done|keep going|don'?t stop|until (it'?s )?(done|finished|complete))\b|ทำจนเสร็จ|อย่าหยุด|ทำต่อจนจบ/i;

export function asksForAutonomy(userText: string): boolean {
  return AUTONOMY_REQUEST.test(userText);
}

export function openTodos(todos: readonly Todo[]): Todo[] {
  return todos.filter((t) => t.status !== "completed");
}

export function continuation(open: readonly Todo[]): string {
  const items = open.map((t) => `- ${t.content}`).join("\n");
  return `Your todo list still has open items:\n${items}\nContinue with them. If one is blocked, say what blocks it and mark the rest.`;
}

export const STATUS_REMINDER = "The user hasn't heard from you in a while — say in a few words what you're doing, then continue.";

/** An assistant message is silent when it calls tools and gives the user no text to read. */
export function isSilentToolStep(content: readonly { type: string; text?: string }[]): boolean {
  const callsTool = content.some((b) => b.type === "toolCall");
  const speaks = content.some((b) => b.type === "text" && (b.text ?? "").trim() !== "");
  return callsTool && !speaks;
}
