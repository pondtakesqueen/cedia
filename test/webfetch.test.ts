import { describe, expect, test } from "vitest";
import { htmlToMarkdown } from "../src/webfetch.ts";

describe("htmlToMarkdown", () => {
  test("converts headings", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toContain("# Title");
  });
  test("converts links", () => {
    expect(htmlToMarkdown('<a href="https://example.com">link</a>')).toContain("[link](https://example.com)");
  });
  test("strips script tags", () => {
    expect(htmlToMarkdown("<p>text</p><script>alert(1)</script>")).not.toContain("alert");
  });
  test("converts paragraphs", () => {
    expect(htmlToMarkdown("<p>Hello world</p>")).toContain("Hello world");
  });
  test("converts bold", () => {
    expect(htmlToMarkdown("<strong>bold</strong>")).toContain("**bold**");
  });
});