import { expect, test } from "vitest";
import { handoffInstructions, skillName } from "../src/handoff.ts";

test("handoff instructions carry todos, unverified files, skills and focus", () => {
  const text = handoffInstructions({
    openTodos: [{ content: "migrate the parser", status: "in_progress" }],
    unverified: ["src/a.ts"],
    skills: ["tdd"],
    focus: "finish the migration",
  });
  expect(text).toContain('"migrate the parser" (in_progress)');
  expect(text).toContain("unverified: src/a.ts");
  expect(text).toContain('"## Suggested Skills"');
  expect(text).toContain("focus on: finish the migration");
  expect(text).toContain("[redacted]");
});

test("empty inputs add no empty sections", () => {
  const text = handoffInstructions({ openTodos: [], unverified: [], skills: [] });
  expect(text).not.toContain("Next Steps");
  expect(text).not.toContain("Suggested Skills");
});

test("skillName reads the directory of a SKILL.md path", () => {
  expect(skillName("/home/u/.agents/skills/tdd/SKILL.md")).toBe("tdd");
  expect(skillName("src/index.ts")).toBeUndefined();
});
