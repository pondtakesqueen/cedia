import { describe, expect, test } from 'bun:test';
import { checkReadOnly } from '../src/core/tools/bash.ts';

describe('read-only bash policy', () => {
  const allowed = [
    'ls -la',
    'git status',
    'git log --oneline -5 | head -3',
    'grep -rn "a>b" src',
    "rg 'x;y' .",
    'find . -name "*.ts" | wc -l',
    'cat a.txt && wc -l a.txt',
    'ls missing 2>/dev/null || echo none',
    'git diff 2>&1 | head',
    "sed -n '1,20p' file.ts",
  ];
  const refused = [
    'rm -rf /',
    'echo hi > out.txt',
    'cat a >> b',
    'ls; rm x',
    'ls & rm x',
    'echo $(whoami)',
    'echo `whoami`',
    'find . -delete',
    'find . -exec rm {} ;',
    "sed -i 's/a/b/' f",
    'git push --force',
    'git commit -m x',
    'git branch -D main',
    'git -c core.pager=sh log',
    'FOO=1 ls',
    'curl https://example.com',
    'sort -o out in',
    "awk 'BEGIN{system(\"rm x\")}'",
    'cat <(ls)',
    'ls "unclosed',
  ];
  for (const c of allowed) test(`allows: ${c}`, () => expect(checkReadOnly(c)).toEqual({ ok: true }));
  for (const c of refused) test(`refuses: ${c}`, () => expect(checkReadOnly(c).ok).toBe(false));
});
