import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { PassThrough } from 'node:stream';
import { Box, render, renderToString, Text } from 'ink';

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

  test('a box drawn again from its last frame moves with the layout and shows changes inside it', async () => {
    type S = { above: number; inner: string; tint: string; width: number };
    const Inner = React.memo(function Inner({ inner, tint }: { inner: string; tint: string }) {
      return (
        <Box flexDirection="column" borderStyle="single">
          <Text>fixed <Text color={tint}>{inner}</Text> end</Text>
          <Text wrap="wrap">{'word '.repeat(12)}</Text>
        </Box>
      );
    });
    const Tree = ({ above, inner, tint, width }: S) => (
      <Box flexDirection="column" width={width}>
        {Array.from({ length: above }, (_, i) => <Text key={i}>above {i}</Text>)}
        <Box overflow="hidden" height={6}><Inner inner={inner} tint={tint} /></Box>
        <Text>below</Text>
      </Box>
    );
    let set: (s: S) => void = () => {};
    function Live() {
      const [s, setS] = React.useState<S>({ above: 1, inner: 'one', tint: 'red', width: 30 });
      set = setS;
      return <Tree {...s} />;
    }
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.assign(stdout, { columns: 40, rows: 30 });
    const app = render(<Live />, { stdout, debug: true, patchConsole: false });
    const instances = (await import(join(import.meta.dir, '../node_modules/ink/build/instances.js'))).default as WeakMap<object, { lastOutput: string }>;
    try {
      for (const s of [
        { above: 3, inner: 'one', tint: 'red', width: 30 },
        { above: 3, inner: 'two', tint: 'red', width: 30 },
        { above: 0, inner: 'two', tint: 'blue', width: 30 },
        { above: 0, inner: 'two', tint: 'blue', width: 20 },
        { above: 2, inner: 'three', tint: 'blue', width: 20 },
      ]) {
        set(s);
        await Bun.sleep(20);
        expect(instances.get(stdout)!.lastOutput).toBe(renderToString(<Tree {...s} />, { columns: 40 }));
      }
    } finally {
      app.unmount();
    }
  });
});
