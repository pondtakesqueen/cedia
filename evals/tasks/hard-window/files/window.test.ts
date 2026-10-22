import { expect, test } from "bun:test";
import { distinctInWindow } from "./window";

test("counts distinct keys in each event's window", () => {
  const events = [
    { t: 0, key: "a" },
    { t: 5, key: "b" },
    { t: 8, key: "a" },
    { t: 20, key: "c" },
  ];
  expect(distinctInWindow(events, 10)).toEqual([1, 2, 2, 1]);
});

test("no events, no counts", () => {
  expect(distinctInWindow([], 10)).toEqual([]);
});

test("a window of zero is refused", () => {
  expect(() => distinctInWindow([{ t: 1, key: "a" }], 0)).toThrow(RangeError);
});
