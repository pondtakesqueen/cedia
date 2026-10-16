import { expect, test } from "vitest";
import { formatAnswers } from "../src/ask.ts";

test("formatAnswers pairs each question with its answer and marks dismissals", () => {
  const text = formatAnswers(
    [
      { question: "Which base?", options: ["pi", "omp"] },
      { question: "Budget?", options: ["$20", "$50"] },
    ],
    ["pi", undefined],
  );
  expect(text).toBe("Which base?\n→ pi\n\nBudget?\n→ (no answer: the user dismissed the question)");
});
