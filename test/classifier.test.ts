import { describe, expect, test } from "vitest";
import { parseBlock } from "../src/classifier.ts";

describe("parseBlock", () => {
  test("yes", () => expect(parseBlock("<block>yes</block>")).toBe(true));
  test("no", () => expect(parseBlock("<block>no</block>")).toBe(false));
  test("case insensitive", () => expect(parseBlock("<BLOCK>Yes</BLOCK>")).toBe(true));
  test("conflicting → null", () => expect(parseBlock("<block>yes</block> <block>no</block>")).toBeNull());
  test("unparseable → null", () => expect(parseBlock("maybe")).toBeNull());
});