import { expect, test } from "bun:test";
import { CsvStream, parseCsv } from "./csv";

test("parses quoted fields, doubled quotes and both row ends", () => {
  expect(parseCsv('a,b\r\n"x,""y""",z\n')).toEqual([
    ["a", "b"],
    ['x,"y"', "z"],
  ]);
});

test("an empty input has no rows, an empty line is one empty field", () => {
  expect(parseCsv("")).toEqual([]);
  expect(parseCsv("a\n\nb")).toEqual([["a"], [""], ["b"]]);
});

test("rejects text after a closing quote", () => {
  expect(() => parseCsv('"a"b')).toThrow(SyntaxError);
});

test("a stream returns a row once its row end arrives, and the rest at the end", () => {
  const s = new CsvStream();
  expect(s.push("a,b\nc,")).toEqual([["a", "b"]]);
  expect(s.push("d")).toEqual([]);
  expect(s.end()).toEqual([["c", "d"]]);
});
