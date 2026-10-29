import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { Box, render, Text } from 'ink';
import xterm from '@xterm/headless';

// The patched Ink writes each frame on the alternate screen by position: moved rows through a scroll region, a
// changed row's changed cells only. Played through a terminal, every frame must leave the screen Ink drew.
const { Terminal } = xterm;
const COLS = 60;
const ROWS = 20;
const instances = (await import(join(import.meta.dir, '../node_modules/ink/build/instances.js'))).default as WeakMap<object, { lastOutput: string }>;
const inkChalk = (await import(join(import.meta.dir, '../node_modules/ink/node_modules/chalk/source/index.js'))).default as { level: number };
inkChalk.level = 3;

type Cell = { getChars(): string; getFgColorMode(): number; getFgColor(): number; getBgColorMode(): number; getBgColor(): number; isBold(): number };
type Term = { write(data: string, done?: () => void): void; buffer: { active: { viewportY: number; getLine(y: number): { getCell(x: number): Cell | undefined } | undefined } } };
const newTerm = () => new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true }) as unknown as Term;
const written = (t: Term, data: string) => new Promise<void>((resolve) => t.write(data, resolve));
const cells = (t: Term): string[] => {
  const b = t.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < ROWS; y++) {
    const line = b.getLine(b.viewportY + y);
    let row = '';
    for (let x = 0; x < COLS; x++) {
      const c = line?.getCell(x);
      row += c ? `${c.getChars() || ' '}${c.getFgColorMode()}.${c.getFgColor()}.${c.getBgColorMode()}.${c.getBgColor()}.${c.isBold()}|` : '?|';
    }
    rows.push(row);
  }
  return rows;
};

let set: (s: { offset: number; input: string; tint: string }) => void = () => {};
const LINES = Array.from({ length: 60 }, (_, i) => (i % 7 === 3 ? `日本語の行 ${i}` : `line ${i} ${'x'.repeat(i % 13)}`));
function Screen() {
  const [s, setS] = React.useState({ offset: 0, input: '', tint: 'green' });
  set = setS;
  return (
    <Box flexDirection="column" height={ROWS}>
      <Text color="cyan" bold>header</Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {LINES.slice(s.offset, s.offset + ROWS - 3).map((l, i) => (
          <Text key={s.offset + i} color={(s.offset + i) % 5 === 0 ? s.tint : undefined}>{l}</Text>
        ))}
      </Box>
      <Text backgroundColor="blue">{`› ${s.input}`.padEnd(COLS - 2)}</Text>
      <Text dimColor>status</Text>
    </Box>
  );
}

describe('the alternate-screen frame writer', () => {
  test('each frame leaves the screen Ink drew, and a scroll moves rows instead of writing them', async () => {
    const term = newTerm();
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: COLS, rows: ROWS });
    let out = '';
    (stdout as unknown as PassThrough).on('data', (d: Buffer) => {
      out += d.toString();
      term.write(d.toString());
    });
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => {} });
    const app = render(<Screen />, { stdout, stdin, alternateScreen: true, incrementalRendering: true, interactive: true, patchConsole: false, maxFps: 1000 });
    const ink = instances.get(stdout)!;
    const step = async (next: { offset: number; input: string; tint: string }) => {
      out = '';
      set(next);
      await Bun.sleep(30);
      await written(term, '');
      const reference = newTerm();
      await written(reference, `\x1b[H\x1b[2J${ink.lastOutput.replace(/\n/g, '\r\n')}`);
      expect(cells(term)).toEqual(cells(reference));
      return out;
    };
    try {
      await Bun.sleep(30);
      let s = { offset: 0, input: '', tint: 'green' };
      const scroll = await step((s = { ...s, offset: 1 }));
      // One row moved: the terminal scrolls a region, and far less than a screen is written.
      expect(scroll).toMatch(/\x1b\[\d+;\d+r\x1b\[1S/);
      expect(scroll.length).toBeLessThan(400);
      await step((s = { ...s, offset: 4 }));
      await step((s = { ...s, offset: 2 }));
      await step((s = { ...s, offset: 30 }));
      const typed = await step((s = { ...s, input: 'hello 日本' }));
      expect(typed.length).toBeLessThan(120);
      await step((s = { ...s, input: 'hel' }));
      await step((s = { ...s, tint: 'red' }));
      await step((s = { ...s, offset: 29, input: '' }));
    } finally {
      app.unmount();
    }
  });
});
