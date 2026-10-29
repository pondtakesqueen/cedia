// The first screen, before any message: the wordmark in block pixels, centered with the model, the place and the
// keys under it. Each glyph is 8 pixel rows (2 for the ascender of d and the dot of i, 6 for the body); two pixel
// rows share a terminal row through the half blocks, so the word is 4 rows tall.
const GLYPHS: Record<string, string[]> = {
  c: ['     ', '     ', '█████', '█    ', '█    ', '█    ', '█    ', '█████'],
  e: ['     ', '     ', '█████', '█   █', '█████', '█    ', '█    ', '█████'],
  d: ['    █', '    █', '█████', '█   █', '█   █', '█   █', '█   █', '█████'],
  i: ['██', '  ', '██', '██', '██', '██', '██', '██'],
  a: ['     ', '     ', '█████', '    █', '█████', '█   █', '█   █', '█████'],
};

/** The word in half blocks, one string per terminal row, all the same width. */
export function wordmark(word = 'cedia'): string[] {
  const glyphs = [...word].map((ch) => GLYPHS[ch]).filter((g): g is string[] => !!g);
  const rows: string[] = [];
  for (let r = 0; r < 8; r += 2) {
    rows.push(glyphs.map((g) => [...g[r]!].map((top, x) => {
      const bottom = g[r + 1]![x] !== ' ';
      return top !== ' ' ? (bottom ? '█' : '▀') : bottom ? '▄' : ' ';
    }).join('')).join(' '));
  }
  return rows;
}

export const WORDMARK_WIDTH = wordmark()[0]!.length;
// The splash needs the word, three lines under it and room around them; a smaller terminal keeps the plain header.
export const SPLASH_MIN_ROWS = 20;
export const SPLASH_MIN_COLUMNS = 44;

export function showSplash(rows: number, columns: number, screenReader: boolean): boolean {
  return !screenReader && rows >= SPLASH_MIN_ROWS && columns >= SPLASH_MIN_COLUMNS;
}
