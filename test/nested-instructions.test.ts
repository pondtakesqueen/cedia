import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nestedInstructions, nestedNote, shownInstructions } from '../src/core/project/instructions.ts';
import { SessionLog } from '../src/core/session/log.ts';

const BIN = join(import.meta.dir, '..', 'bin', 'cedia');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-nested-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'pkg', 'deep'), { recursive: true });
  mkdirSync(join(dir, 'other'), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), 'root rules\n');
  writeFileSync(join(dir, 'pkg', 'AGENTS.md'), 'pkg rules: use tabs\n');
  writeFileSync(join(dir, 'pkg', 'deep', 'CLAUDE.md'), 'deep rules\n');
  writeFileSync(join(dir, 'pkg', 'deep', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'other', 'b.ts'), 'export const b = 2;\n');
  return dir;
}

describe("a folder's own AGENTS.md, on the first file call under it", () => {
  test('the files between the working directory and the file, nearer last; none the first turn had or the session saw', () => {
    const dir = repo();
    const got = nestedInstructions(dir, 'pkg/deep/a.ts', new Set());
    expect(got).toEqual([
      { path: join('pkg', 'AGENTS.md'), text: 'pkg rules: use tabs' },
      { path: join('pkg', 'deep', 'CLAUDE.md'), text: 'deep rules' },
    ]);
    const note = nestedNote(got);
    expect(note).toContain('<project_instructions path="pkg/AGENTS.md">\npkg rules: use tabs\n</project_instructions>');
    // Once seen, a file is not shown again; the rest still are.
    expect(nestedInstructions(dir, join(dir, 'pkg', 'deep', 'a.ts'), shownInstructions([note]))).toEqual([]);
    expect(nestedInstructions(dir, 'pkg/deep/a.ts', shownInstructions(['<project_instructions path="pkg/AGENTS.md">']))).toEqual([{ path: join('pkg', 'deep', 'CLAUDE.md'), text: 'deep rules' }]);
    // Started inside pkg, its own file was in the first turn: only the deeper one is new.
    expect(nestedInstructions(join(dir, 'pkg'), 'deep/a.ts', new Set()).map((f) => f.path)).toEqual([join('pkg', 'deep', 'CLAUDE.md')]);
    // A folder without instructions, the root's own files, and paths outside the repository add nothing.
    expect(nestedInstructions(dir, 'other/b.ts', new Set())).toEqual([]);
    expect(nestedInstructions(dir, 'README.md', new Set())).toEqual([]);
    expect(nestedInstructions(dir, '/etc/hosts', new Set())).toEqual([]);
    expect(nestedNote([])).toBe('');
  });

  test('e2e: the first read under pkg carries its rules, the next call does not, and the log holds them (offline, faux)', () => {
    const dir = repo();
    const home = join(dir, '.git', 'cedia-home');
    mkdirSync(home, { recursive: true });
    const script = join(home, 'script.json');
    const use = (id: string, name: string, input: unknown) => ({ blocks: [{ type: 'tool_use', id, name, input }] });
    writeFileSync(script, JSON.stringify([use('c1', 'read', { path: 'pkg/deep/a.ts' }), use('c2', 'edit', { path: 'pkg/deep/a.ts', edits: [{ old: '1', new: '3' }] }), use('c3', 'read', { path: 'other/b.ts' }), { blocks: [{ type: 'text', text: 'done' }] }]));
    const p = Bun.spawnSync([BIN, '-m', 'faux', '-p', 'go', '--permission', 'workspace', '--sandbox', 'off', '--output-format', 'json', '--cwd', dir], { env: { ...process.env, CEDIA_FAUX_SCRIPT: script, CEDIA_HOME: home }, stdin: 'ignore' });
    expect(p.exitCode).toBe(0);
    const logs = Bun.spawnSync(['find', home, '-path', '*sessions*', '-name', '*.jsonl']).stdout.toString().trim().split('\n').filter(Boolean);
    expect(logs).toHaveLength(1);
    const results = SessionLog.load(logs[0]!).events.flatMap((e) => (e.kind === 'tool_result' ? [e.output.text] : []));
    expect(results).toHaveLength(3);
    expect(results[0]).toContain('<project_instructions path="pkg/AGENTS.md">');
    expect(results[0]).toContain('<project_instructions path="pkg/deep/CLAUDE.md">');
    expect(results[1]).not.toContain('project_instructions');
    expect(results[2]).not.toContain('project_instructions');
    // The root's file was in the first turn, never repeated after a result.
    expect(results.join('\n')).not.toContain('root rules');
  });
});
