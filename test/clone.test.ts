import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneTree } from '../src/core/project/clone.ts';

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-clone-'));
  const from = join(dir, 'node_modules');
  mkdirSync(join(from, 'pkg', 'lib'), { recursive: true });
  writeFileSync(join(from, 'pkg', 'lib', 'index.js'), 'module.exports = 1;\n');
  symlinkSync('pkg/lib/index.js', join(from, 'entry.js'));
  return { dir, from };
}

describe('copy-on-write clones', () => {
  test('a directory clones whole on macOS, links kept as links, and each side keeps its own writes', () => {
    const { dir, from } = tree();
    const to = join(dir, 'clone');
    const cloned = cloneTree(from, to);
    if (process.platform === 'darwin') expect(cloned).toBe(true);
    if (!cloned) {
      // Where the filesystem cannot clone, nothing is left behind.
      expect(existsSync(to)).toBe(false);
      return;
    }
    expect(readFileSync(join(to, 'pkg', 'lib', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(lstatSync(join(to, 'entry.js')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(to, 'entry.js'))).toBe('pkg/lib/index.js');
    writeFileSync(join(to, 'pkg', 'lib', 'index.js'), 'module.exports = 2;\n');
    writeFileSync(join(from, 'pkg', 'new.js'), 'parent only\n');
    expect(readFileSync(join(from, 'pkg', 'lib', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(existsSync(join(to, 'pkg', 'new.js'))).toBe(false);
  });

  test('an existing destination is never written into', () => {
    const { dir, from } = tree();
    const to = join(dir, 'taken');
    mkdirSync(to);
    writeFileSync(join(to, 'mine.txt'), 'keep\n');
    expect(cloneTree(from, to)).toBe(false);
    expect(readFileSync(join(to, 'mine.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(to, 'pkg'))).toBe(false);
  });
});
