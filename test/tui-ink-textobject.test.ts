import { describe, expect, test } from 'bun:test';
import { isTextObjectChar, textObjectRange } from '../src/clients/tui-ink/vim-textobject.ts';

describe('ink vim text objects', () => {
  test('iw and aw select the word under the cursor', () => {
    const t = 'foo bar baz';
    // cursor on 'a' of bar (index 5)
    expect(textObjectRange(t, 5, 'i', 'w')).toEqual({ lo: 4, hi: 7 });
    expect(textObjectRange(t, 5, 'a', 'w')).toEqual({ lo: 4, hi: 8 }); // includes trailing space
  });

  test('iw on spaces selects the whitespace run', () => {
    const t = 'ab  cd';
    expect(textObjectRange(t, 2, 'i', 'w')).toEqual({ lo: 2, hi: 4 });
  });

  test('iW and aW use WORD (non-whitespace) boundaries', () => {
    const t = 'foo-bar  x';
    expect(textObjectRange(t, 3, 'i', 'W')).toEqual({ lo: 0, hi: 7 });
    expect(textObjectRange(t, 3, 'a', 'W')).toEqual({ lo: 0, hi: 9 });
  });

  test('quotes: i" and a"', () => {
    const t = 'say "hello" now';
    expect(textObjectRange(t, 6, 'i', '"')).toEqual({ lo: 5, hi: 10 });
    expect(textObjectRange(t, 6, 'a', '"')).toEqual({ lo: 4, hi: 11 });
  });

  test('brackets: ib/ab and i(/a(', () => {
    const t = 'f(a(b)c)z';
    // cursor on b
    expect(textObjectRange(t, 4, 'i', 'b')).toEqual({ lo: 4, hi: 5 });
    expect(textObjectRange(t, 4, 'a', '(')).toEqual({ lo: 3, hi: 6 });
    // cursor inside outer paren on 'a'
    expect(textObjectRange(t, 2, 'i', '(')).toEqual({ lo: 2, hi: 7 });
    expect(textObjectRange(t, 2, 'a', 'b')).toEqual({ lo: 1, hi: 8 });
  });

  test('isTextObjectChar accepts the supported set', () => {
    expect(isTextObjectChar('w')).toBe(true);
    expect(isTextObjectChar('W')).toBe(true);
    expect(isTextObjectChar('"')).toBe(true);
    expect(isTextObjectChar('b')).toBe(true);
    expect(isTextObjectChar('B')).toBe(true);
    expect(isTextObjectChar('t')).toBe(true);
    expect(isTextObjectChar('x')).toBe(false);
  });

  test('missing pairs return null', () => {
    expect(textObjectRange('no quotes', 2, 'i', '"')).toBeNull();
    expect(textObjectRange('no (close', 4, 'i', '(')).toBeNull();
  });
});
