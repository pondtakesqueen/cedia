/**
 * CSV as this service reads it:
 * - Fields are separated by `,`, and a row ends at `\n` or `\r\n`. A `\r` that is not followed by `\n` is part of
 *   its field.
 * - A field that starts with `"` is quoted: it runs to the next `"` that is not doubled, `""` inside it stands for
 *   one `"`, and it may hold `,`, `\r` and `\n`. After its closing quote comes `,`, a row end or the end of the
 *   input, or else it is a SyntaxError. So is a `"` anywhere in a field that is not quoted, and a quoted field
 *   still open at the end of the input.
 * - A `﻿` at the very start of the input is dropped.
 * - The end of the input ends the last row, and a row end just before it does not start another one. An empty
 *   input has no rows; an empty line is a row of one empty field.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let i = text.startsWith("﻿") ? 1 : 0;
  if (i >= text.length) return rows;
  const rowEnd = (at: number) => text[at] === "\n" || (text[at] === "\r" && text[at + 1] === "\n");
  let row: string[] = [];
  for (;;) {
    let field = "";
    if (text[i] === '"') {
      i++;
      for (;;) {
        if (i >= text.length) throw new SyntaxError("a quoted field is still open at the end of the input");
        const c = text[i++]!;
        if (c !== '"') field += c;
        else if (text[i] === '"') {
          field += '"';
          i++;
        } else break;
      }
      if (i < text.length && text[i] !== "," && !rowEnd(i)) throw new SyntaxError(`unexpected ${JSON.stringify(text[i])} after a closing quote at offset ${i}`);
    } else {
      while (i < text.length && text[i] !== "," && !rowEnd(i)) {
        if (text[i] === '"') throw new SyntaxError(`a quote in a field that is not quoted, at offset ${i}`);
        field += text[i++];
      }
    }
    row.push(field);
    if (i >= text.length) break;
    if (text[i] === ",") {
      i++;
      continue;
    }
    i += text[i] === "\r" ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= text.length) return rows;
  }
  rows.push(row);
  return rows;
}
