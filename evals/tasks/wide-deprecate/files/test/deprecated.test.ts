import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as logModule from '../src/log.ts';
import * as compat from '../src/compat.ts';

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

test('oldLog is gone: not exported, not re-exported, not named anywhere in src/', () => {
  expect('oldLog' in logModule).toBe(false);
  expect('oldLog' in compat).toBe(false);
  expect(compat.VERSION).toBe('1.4.0');
  const left = files(join(import.meta.dir, '..', 'src')).filter((f) => readFileSync(f, 'utf8').includes('oldLog'));
  expect(left).toEqual([]);
});
