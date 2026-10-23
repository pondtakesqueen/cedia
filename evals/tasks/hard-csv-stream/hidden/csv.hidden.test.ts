import { expect, test } from "bun:test";
import { CsvStream, parseCsv } from "./csv";

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

type Outcome = { rows: string[][] } | { error: true };

const whole = (text: string): Outcome => {
  try {
    return { rows: parseCsv(text) };
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return { error: true };
  }
};

function streamed(chunks: string[]): Outcome {
  const s = new CsvStream();
  const rows: string[][] = [];
  try {
    for (const c of chunks) rows.push(...s.push(c));
    rows.push(...s.end());
    return { rows };
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return { error: true };
  }
}

function split(text: string, r: () => number, maxLen: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    // Empty chunks too.
    const n = Math.floor(r() * (maxLen + 1));
    out.push(text.slice(i, i + n));
    i += n;
  }
  if (r() < 0.3) out.push("");
  return out;
}

// Valid CSV, with every awkward thing in it: quotes, doubled quotes, separators and row ends inside quotes, lone
// `\r` in plain fields, both row ends, empty fields and lines, a BOM, a trailing row end or none.
function validCsv(r: () => number): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const rows: string[] = [];
  const nRows = Math.floor(r() * 6);
  for (let i = 0; i < nRows; i++) {
    const fields: string[] = [];
    const nFields = 1 + Math.floor(r() * 4);
    for (let j = 0; j < nFields; j++) {
      const len = Math.floor(r() * 5);
      if (r() < 0.5) {
        let s = "";
        for (let k = 0; k < len; k++) s += pick(["a", "é", ",", '""', "\n", "\r", "\r\n", " "]);
        fields.push(`"${s}"`);
      } else {
        let s = "";
        for (let k = 0; k < len; k++) s += pick(["b", "ü", " ", "\r"]);
        // A plain field ending in `\r` would join the row end after it.
        fields.push(s.replace(/\r+$/, ""));
      }
    }
    rows.push(fields.join(","));
  }
  const ends = rows.map(() => pick(["\n", "\r\n"]));
  let text = rows.map((row, i) => row + (i < rows.length - 1 ? ends[i] : "")).join("");
  if (rows.length && r() < 0.5) text += pick(["\n", "\r\n"]);
  if (r() < 0.2) text = "﻿" + text;
  return text;
}

test("any split of valid CSV gives the rows parseCsv gives", () => {
  const r = rng(7);
  for (let n = 0; n < 3000; n++) {
    const text = validCsv(r);
    expect(whole(text)).not.toEqual({ error: true });
    for (const maxLen of [1, 2, 3, 8])
      expect({ text, maxLen, ...streamed(split(text, r, maxLen)) }).toEqual({ text, maxLen, ...whole(text) });
  }
});

test("any split of any short text: the same rows, or a SyntaxError in both", () => {
  const r = rng(11);
  const alphabet = ["a", ",", '"', "\r", "\n", "﻿"];
  for (let n = 0; n < 20000; n++) {
    let text = "";
    const len = Math.floor(r() * 9);
    for (let k = 0; k < len; k++) text += alphabet[Math.floor(r() * alphabet.length)];
    const chunks = split(text, r, 3);
    expect({ text, chunks, ...streamed(chunks) }).toEqual({ text, chunks, ...whole(text) });
  }
});

test("every chunk boundary inside the hard spots", () => {
  for (const text of ['"a""b",c\r\n', '"x"\r\ny', 'a\rb\r\nc', '""""', '"a"\r', "a\r", '"', '"a"x', "﻿a,b", ",\n,", 'a,"b\r\nc"\r\n']) {
    for (let i = 0; i <= text.length; i++)
      for (let j = i; j <= text.length; j++) {
        const chunks = [text.slice(0, i), text.slice(i, j), text.slice(j)];
        expect({ chunks, ...streamed(chunks) }).toEqual({ chunks, ...whole(text) });
      }
  }
});

// Where the rows of a valid input end: a `\n` outside quotes (in valid CSV, after an even number of quotes).
function rowEnds(text: string): number[] {
  const ends: number[] = [];
  let quotes = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quotes++;
    else if (text[i] === "\n" && quotes % 2 === 0) ends.push(i + 1);
  }
  return ends;
}

test("each push returns the rows whose row end has arrived, no fewer and no more", () => {
  const r = rng(23);
  for (let n = 0; n < 2000; n++) {
    const text = validCsv(r);
    const ends = rowEnds(text);
    const s = new CsvStream();
    const got: string[][] = [];
    let at = 0;
    for (const chunk of split(text, r, 4)) {
      got.push(...s.push(chunk));
      at += chunk.length;
      const done = ends.filter((e) => e <= at).at(-1) ?? 0;
      expect({ text, at, got }).toEqual({ text, at, got: done ? parseCsv(text.slice(0, done)) : [] });
    }
  }
});

test("one character at a time through a large file stays fast", () => {
  const big = '"' + "x,".repeat(100_000) + '"\n' + "a,b,c\r\n".repeat(40_000);
  const s = new CsvStream();
  let rows = 0;
  const started = performance.now();
  for (let i = 0; i < big.length; i++) rows += s.push(big[i]!).length;
  rows += s.end().length;
  const ms = performance.now() - started;
  expect(rows).toBe(40_001);
  expect(ms).toBeLessThan(3000);
});

test("streams are independent", () => {
  const a = new CsvStream();
  const b = new CsvStream();
  a.push('"x');
  expect(b.push("y\n")).toEqual([["y"]]);
  expect(a.push('"\n')).toEqual([["x"]]);
});
