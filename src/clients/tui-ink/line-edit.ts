// The prompt's editing keys outside vim mode, as pure steps on (text, cursor): readline's ctrl+a/e/u/k/w and
// alt+b/f/backspace, which a terminal user's hands already know. Each returns the new text and cursor.

export type Edit = { value: string; cursor: number };

const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

export const lineStart = (v: string, c: number) => v.lastIndexOf('\n', c - 1) + 1;
export const lineEnd = (v: string, c: number) => {
  const nl = v.indexOf('\n', c);
  return nl < 0 ? v.length : nl;
};

export function wordLeft(v: string, c: number): number {
  let i = c;
  while (i > 0 && !isWord(v[i - 1])) i--;
  while (i > 0 && isWord(v[i - 1])) i--;
  return i;
}

export function wordRight(v: string, c: number): number {
  let i = c;
  while (i < v.length && !isWord(v[i])) i++;
  while (i < v.length && isWord(v[i])) i++;
  return i;
}

export function insert(e: Edit, text: string): Edit {
  return { value: e.value.slice(0, e.cursor) + text + e.value.slice(e.cursor), cursor: e.cursor + text.length };
}

// Cut [from, to) and leave the cursor at its start.
const cut = (e: Edit, from: number, to: number): Edit =>
  to <= from ? e : { value: e.value.slice(0, from) + e.value.slice(to), cursor: from };

// The cursor steps by what shows as one character (a grapheme): an emoji, or a Thai consonant with its vowel and
// tone marks, moves and deletes in one press instead of leaving half a surrogate pair or a stray mark.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function prevStop(v: string, c: number): number {
  if (c <= 0) return 0;
  let at = 0;
  for (const { index } of graphemes.segment(v.slice(0, c))) at = index;
  return at;
}

export function nextStop(v: string, c: number): number {
  if (c >= v.length) return v.length;
  const first = graphemes.segment(v.slice(c))[Symbol.iterator]().next();
  return first.done ? v.length : c + first.value.segment.length;
}

// A paste's token goes in one press too: half a token would no longer expand.
const TOKEN_BEFORE = /\[Pasted text #\d+ [^\]\n]+\]$/;

export function backspace(e: Edit): Edit {
  const token = TOKEN_BEFORE.exec(e.value.slice(0, e.cursor));
  return cut(e, token ? e.cursor - token[0].length : prevStop(e.value, e.cursor), e.cursor);
}
export const deleteForward = (e: Edit): Edit => cut(e, e.cursor, nextStop(e.value, e.cursor));

export const killToLineStart = (e: Edit): Edit => {
  const s = lineStart(e.value, e.cursor);
  // At a line's start, ctrl+u joins it to the line above, as readline does in a multi-line buffer.
  return cut(e, s === e.cursor && s > 0 ? s - 1 : s, e.cursor);
};
export const killToLineEnd = (e: Edit): Edit => {
  const end = lineEnd(e.value, e.cursor);
  return cut(e, e.cursor, end === e.cursor && end < e.value.length ? end + 1 : end);
};
export const killWordBack = (e: Edit): Edit => cut(e, wordLeft(e.value, e.cursor), e.cursor);
export const killWordForward = (e: Edit): Edit => cut(e, e.cursor, wordRight(e.value, e.cursor));

/** What a key adds to the prompt: everything but control bytes, so Thai, accents and emoji go in as typed. */
export const typed = (input: string): string => input.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

// A paste of many lines shows as one token in the prompt (the text itself goes to the model on submit), so a
// pasted log does not push the transcript off the screen.
export const PASTE_LINES = 8;
export const PASTE_CHARS = 1000;

const lineCount = (text: string) => text.replace(/\n$/, '').split('\n').length;

export const pasteToken = (n: number, text: string): string => {
  const lines = lineCount(text);
  return lines > 1 ? `[Pasted text #${n} +${lines} lines]` : `[Pasted text #${n} ${text.length} chars]`;
};

export const collapses = (text: string): boolean => lineCount(text) > PASTE_LINES || text.length > PASTE_CHARS;

/** Put each paste's text back where its token stands. */
export function expandPastes(text: string, pastes: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [token, body] of pastes) out = out.split(token).join(body);
  return out;
}

/** Terminals send \r for a newline inside a paste. */
export const normalizePaste = (text: string): string => text.replace(/\r\n?/g, '\n');
