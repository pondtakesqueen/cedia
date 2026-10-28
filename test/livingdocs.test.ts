import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLivingDocs, livingSection, updateLivingSection } from '../src/core/project/livingdocs.ts';

describe('livingdocs', () => {
  test('find and update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-ld-'));
    writeFileSync(join(dir, 'doc.md'), '# LIVING DOC: Demo\n\n<!-- LIVING:START -->\nold\n<!-- LIVING:END -->\n');
    const docs = findLivingDocs(dir);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe('Demo');
    expect(updateLivingSection(docs[0]!.path, 'new content')).toBe(true);
    const text = readFileSync(docs[0]!.path, 'utf8');
    expect(text).toContain('<!-- LIVING:START -->\nnew content\n<!-- LIVING:END -->');
    expect(text).not.toContain('old');
  });

  test('a file with the older header and markers is still found and updated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cedia-ld-'));
    writeFileSync(join(dir, 'old.md'), '# MAGIC DOC: Legacy\n\n<!-- MAGIC:START -->\nold\n<!-- MAGIC:END -->\n');
    const docs = findLivingDocs(dir);
    expect(docs.map((d) => d.title)).toEqual(['Legacy']);
    expect(updateLivingSection(docs[0]!.path, 'fresh')).toBe(true);
    expect(readFileSync(docs[0]!.path, 'utf8')).toContain('<!-- MAGIC:START -->\nfresh\n<!-- MAGIC:END -->');
  });

  test('no section without both markers in order', () => {
    expect(livingSection('<!-- LIVING:END --> <!-- LIVING:START -->')).toBeUndefined();
    expect(livingSection('no markers')).toBeUndefined();
  });
});
