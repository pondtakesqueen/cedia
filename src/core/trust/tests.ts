import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_FILE } from './slop.ts';

// A task that says to leave the existing tests alone gets that as a rule rather than a request: the test files
// already in the working directory join the run's policy as paths no tool may change (core/safety/policy.ts),
// and new tests go in new files. A prompt rule alone left 1 of 24 runs editing a protected test after #119, and
// 5 before it (evals/results/README.md); a denied call costs nothing.

// "do not change the existing tests", "don't modify tests", "leave the tests alone", "อย่าแก้เทสต์เดิม". A clause
// that goes on with unless or except leaves the choice to the writer.
const LEAVE_ALONE = [
  /\b(?:do not|don't|never)\s+(?:change|modify|edit|touch|alter|rewrite|update)\s+(?:the\s+|any\s+)?(?:existing\s+|current\s+|original\s+|provided\s+|given\s+)?tests?\b(?![^.;\n]*\b(?:unless|except)\b)/i,
  /\bleave\s+(?:the\s+|all\s+)?(?:existing\s+)?tests?\s+(?:alone|unchanged|untouched|as\s+(?:they\s+are|is))\b/i,
  /(?:อย่า|ห้าม)\s*(?:แก้ไข|แก้|เปลี่ยน|แตะ)\s*(?:ไฟล์\s*)?(?:test|เทสต์|เทส)/i,
];

export const leavesTestsAlone = (prompt: string): boolean => LEAVE_ALONE.some((re) => re.test(prompt));

// Directories no test of the task lives in: dependencies, build output, and dot directories (.git, .cedia).
const SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', 'coverage']);
const MAX_FILES = 20_000;

// The test files under cwd, relative to it, as the slop guard knows them (TEST_FILE).
export function existingTests(cwd: string): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_FILES) return;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP.has(e.name)) walk(path);
      } else if (e.isFile() && TEST_FILE.test(path)) out.push(path);
    }
  };
  walk('');
  return out.sort();
}

export const PROTECTED_TEST_REASON = 'the task says to leave the existing tests alone, so the test files that were here before this run stay as they are; put new tests in a new test file';
