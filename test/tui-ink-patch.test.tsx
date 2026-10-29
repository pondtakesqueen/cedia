import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { Box, renderToString, Text } from 'ink';

// The styles are what is under test, so Ink's own chalk draws them even though the output is not a terminal.
const inkChalk = (await import(join(import.meta.dir, '../node_modules/ink/node_modules/chalk/source/index.js'))).default as { level: number };
inkChalk.level = 1;

// patches/ink@8.0.0.patch keeps Ink's text caches across frames. A cache keyed on the wrong thing would draw a
// frame from an earlier one, so each case draws something that differs from the frame before in one way only.
const draw = (node: React.ReactElement) => renderToString(node, { columns: 40 });
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';

describe('the Ink patch', () => {
  test('is applied', () => {
    expect(existsSync(join(import.meta.dir, '../node_modules/ink/build/transform-cache.js'))).toBe(true);
  });

  test('a style change draws the new style over the same text', () => {
    expect(draw(<Text color="red">same</Text>)).toContain(`${RED}same`);
    const blue = draw(<Text color="blue">same</Text>);
    expect(blue).toContain(`${BLUE}same`);
    expect(blue).not.toContain(RED);
    expect(draw(<Text>same</Text>)).toBe('same');
  });

  test('nested styles keep their own colors when only one of them changes', () => {
    const a = draw(<Text>a <Text color="red">b</Text> c</Text>);
    const b = draw(<Text>a <Text color="blue">b</Text> c</Text>);
    expect(a).toContain(`${RED}b`);
    expect(b).toContain(`${BLUE}b`);
    expect(b).not.toContain(RED);
  });

  test('a row with the same width but other text is drawn again', () => {
    expect(draw(<Box flexDirection="column"><Text>abc</Text><Text>xyz</Text></Box>)).toBe('abc\nxyz');
    expect(draw(<Box flexDirection="column"><Text>abd</Text><Text>xyz</Text></Box>)).toBe('abd\nxyz');
    expect(draw(<Box flexDirection="column"><Text>xyz</Text><Text>abd</Text></Box>)).toBe('xyz\nabd');
  });

  test('a clipped line is cut where the box ends, each time', () => {
    const clipped = (s: string) => draw(<Box width={5} overflow="hidden"><Text wrap="truncate-end">{s}</Text></Box>);
    expect(clipped('abcdefgh')).toBe('abcd…');
    expect(clipped('abcdxfgh')).toBe('abcd…');
    expect(clipped('zbcdefgh')).toBe('zbcd…');
  });
});
