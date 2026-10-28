import { describe, expect, test } from 'bun:test';
import {
  backspace,
  collapses,
  deleteForward,
  expandPastes,
  killToLineEnd,
  killToLineStart,
  killWordBack,
  lineEnd,
  lineStart,
  nextStop,
  pasteToken,
  prevStop,
  typed,
  wordLeft,
  wordRight,
} from '../src/clients/tui-ink/line-edit.ts';

describe('prompt line editing', () => {
  test('typed keeps Thai, accents and emoji, drops control bytes', () => {
    expect(typed('สวัสดี café 🎉')).toBe('สวัสดี café 🎉');
    expect(typed('a\x01b\x1bc\x7f')).toBe('abc');
  });

  test('the cursor steps over a whole grapheme', () => {
    const v = 'a🎉b';
    expect(nextStop(v, 1)).toBe(3);
    expect(prevStop(v, 3)).toBe(1);
    // ที่ is one consonant with a vowel and a tone mark: one step.
    expect(nextStop('ที่', 0)).toBe(3);
    expect(backspace({ value: 'xที่', cursor: 4 })).toEqual({ value: 'x', cursor: 1 });
    expect(backspace({ value: 'a🎉', cursor: 3 })).toEqual({ value: 'a', cursor: 1 });
    expect(deleteForward({ value: '🎉a', cursor: 0 })).toEqual({ value: 'a', cursor: 0 });
  });

  test('readline kills and word moves', () => {
    expect(lineStart('ab\ncd', 4)).toBe(3);
    expect(lineEnd('ab\ncd', 0)).toBe(2);
    expect(killToLineStart({ value: 'hello world', cursor: 6 })).toEqual({ value: 'world', cursor: 0 });
    // At a line's start, ctrl+u joins the line to the one above.
    expect(killToLineStart({ value: 'ab\ncd', cursor: 3 })).toEqual({ value: 'abcd', cursor: 2 });
    expect(killToLineEnd({ value: 'hello world', cursor: 5 })).toEqual({ value: 'hello', cursor: 5 });
    expect(killToLineEnd({ value: 'ab\ncd', cursor: 2 })).toEqual({ value: 'abcd', cursor: 2 });
    expect(killWordBack({ value: 'git commit -m', cursor: 10 })).toEqual({ value: 'git  -m', cursor: 4 });
    expect(wordLeft('foo bar', 7)).toBe(4);
    expect(wordRight('foo bar', 0)).toBe(3);
  });

  test('a long paste stands as one token that expands on submit and deletes whole', () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    expect(collapses(body)).toBe(true);
    expect(collapses('one\ntwo')).toBe(false);
    const token = pasteToken(1, body);
    expect(token).toBe('[Pasted text #1 +40 lines]');
    expect(expandPastes(`see ${token} ok`, new Map([[token, body]]))).toBe(`see ${body} ok`);
    const v = `see ${token}`;
    expect(backspace({ value: v, cursor: v.length })).toEqual({ value: 'see ', cursor: 4 });
    expect(pasteToken(2, 'x'.repeat(1200))).toBe('[Pasted text #2 1200 chars]');
  });
});
