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

// Reads the same CSV as parseCsv a chunk at a time. Each character is looked at once; the only thing held over a
// chunk boundary is the state of the field being read and a `\r` whose meaning waits on the next character.
export class CsvStream {
  private out: string[][] = [];
  private row: string[] = [];
  private field = "";
  // start: at the start of a field; plain: in a field that is not quoted; quoted: in a quoted field; quote: just
  // after a `"` in a quoted field (closing it, or the first of `""`).
  private state: "start" | "plain" | "quoted" | "quote" = "start";
  private cr = false;
  private began = false;
  private offset = 0;

  push(chunk: string): string[][] {
    for (let k = 0; k < chunk.length; k++, this.offset++) {
      const c = chunk[k]!;
      if (!this.began) {
        this.began = true;
        if (c === "﻿" && this.offset === 0) continue;
      }
      if (this.cr) {
        this.cr = false;
        if (c === "\n") {
          this.endRow();
          continue;
        }
        if (this.state === "quote") throw new SyntaxError(`unexpected "\\r" after a closing quote at offset ${this.offset - 1}`);
        this.field += "\r";
      }
      this.step(c);
    }
    return this.take();
  }

  end(): string[][] {
    if (this.state === "quoted") throw new SyntaxError("a quoted field is still open at the end of the input");
    if (this.cr) {
      if (this.state === "quote") throw new SyntaxError('unexpected "\\r" after a closing quote at the end of the input');
      this.field += "\r";
      this.cr = false;
    }
    if (this.state !== "start" || this.row.length) this.endRow();
    return this.take();
  }

  private step(c: string) {
    switch (this.state) {
      case "quoted":
        if (c === '"') this.state = "quote";
        else this.field += c;
        return;
      case "quote":
        if (c === '"') {
          this.field += '"';
          this.state = "quoted";
        } else if (c === ",") this.endField();
        else if (c === "\n") this.endRow();
        else if (c === "\r") this.cr = true;
        else throw new SyntaxError(`unexpected ${JSON.stringify(c)} after a closing quote at offset ${this.offset}`);
        return;
      case "start":
        if (c === '"') {
          this.state = "quoted";
          return;
        }
      // A field that is not quoted starts like one that goes on.
      case "plain":
        this.state = "plain";
        if (c === ",") this.endField();
        else if (c === "\n") this.endRow();
        else if (c === "\r") this.cr = true;
        else if (c === '"') throw new SyntaxError(`a quote in a field that is not quoted, at offset ${this.offset}`);
        else this.field += c;
    }
  }

  private endField() {
    this.row.push(this.field);
    this.field = "";
    this.state = "start";
  }

  private endRow() {
    this.row.push(this.field);
    this.out.push(this.row);
    this.row = [];
    this.field = "";
    this.state = "start";
  }

  private take() {
    const rows = this.out;
    this.out = [];
    return rows;
  }
}
