export interface Question {
  question: string;
  options: string[];
}

export const OTHER = "Other (type an answer)";

export const NO_UI_ANSWER =
  "No one can answer dialogs in this mode. Ask the question in plain text in your reply, or proceed on a stated assumption if the work allows it.";

export function formatAnswers(questions: readonly Question[], answers: readonly (string | undefined)[]): string {
  return questions.map((q, i) => `${q.question}\n→ ${answers[i] ?? "(no answer: the user dismissed the question)"}`).join("\n\n");
}
