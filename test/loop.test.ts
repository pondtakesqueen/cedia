import { expect, test } from "vitest";
import { asksForAutonomy, continuation, isSilentToolStep, openTodos } from "../src/loop.ts";

test.each(["run until done", "keep going", "don't stop until it's finished", "ทำจนเสร็จ", "อย่าหยุดนะ"])("%s asks for autonomy", (text) => {
  expect(asksForAutonomy(text)).toBe(true);
});

test("an ordinary request does not ask for autonomy", () => {
  expect(asksForAutonomy("fix the parser bug")).toBe(false);
});

test("open todos are everything not completed, and the continuation names each", () => {
  const open = openTodos([
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "pending" },
  ]);
  expect(open.map((t) => t.content)).toEqual(["b", "c"]);
  expect(continuation(open)).toContain("- b\n- c");
});

test("a tool step is silent only when it has no readable text", () => {
  expect(isSilentToolStep([{ type: "toolCall" }])).toBe(true);
  expect(isSilentToolStep([{ type: "text", text: "  " }, { type: "toolCall" }])).toBe(true);
  expect(isSilentToolStep([{ type: "text", text: "Reading the parser." }, { type: "toolCall" }])).toBe(false);
  expect(isSilentToolStep([{ type: "text", text: "Done." }])).toBe(false);
});
