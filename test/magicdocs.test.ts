import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMagicDocs, updateMagicSection } from '../src/core/project/magicdocs.ts';

describe('magicdocs', () => {
  test('find and update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-md-'));
    writeFileSync(join(dir, 'doc.md'), '# MAGIC DOC: Demo\n\n<!-- MAGIC:START -->\nold\n<!-- MAGIC:END -->\n');
    const docs = findMagicDocs(dir);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe('Demo');
    expect(updateMagicSection(docs[0]!.path, 'new content')).toBe(true);
    const text = require('node:fs').readFileSync(docs[0]!.path, 'utf8');
    expect(text).toContain('new content');
    expect(text).not.toContain('old');
  });
});
