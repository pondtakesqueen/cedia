import { expect, test } from "bun:test";
import { maxSatisfying, satisfies } from "./semver";

test("plain comparators", () => {
  expect(satisfies("1.2.3", ">=1.2.0 <2.0.0")).toBe(true);
  expect(satisfies("2.0.0", ">=1.2.0 <2.0.0")).toBe(false);
  expect(satisfies("1.2.3", "1.2.3")).toBe(true);
});

test("caret and tilde on 1.x", () => {
  expect(satisfies("1.9.0", "^1.2.3")).toBe(true);
  expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
});

test("either side of ||", () => {
  expect(satisfies("3.0.0", "^1.0.0 || ^3.0.0")).toBe(true);
});

test("maxSatisfying", () => {
  expect(maxSatisfying(["1.2.3", "1.2.4", "1.3.0"], "~1.2.0")).toBe("1.2.4");
});
