import type { SessionEvent } from '../types.ts';
import { editsOf } from '../tools/edit.ts';

// The slop guard reads what a run changed and flags the shortcuts an agent takes to look done: tests weakened,
// skipped or deleted, checks silenced in the code or turned off in their config, errors swallowed, types escaped,
// stubs left in place. Each finding is a line the run added (or a test it removed), never what the file already had.
export type FileChange = { path: string; added: string[]; removed: string[]; deleted: boolean };
export type SlopRule = 'test-deleted' | 'test-weakened' | 'test-skipped' | 'suppression' | 'swallowed-error' | 'type-escape' | 'stub' | 'config-weakened';
export type SlopFinding = { rule: SlopRule; path: string; line?: string };

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|rs)$/;
// Prose may quote any of these patterns; only code is scanned.
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const ASSERTION = /\b(expect|assert\w*|should)\b|\b(it|test|describe)\s*\(/;

// The code of a line without its comments, strings and regex literals, for rules about code that prose may
// name: "the rule matches: any key" in a comment, or a detector's own pattern, is not a type escape.
export function codeOf(line: string): string {
  if (COMMENT_LINE.test(line)) return '';
  return withoutRegex(line.replace(STRING, '""')).replace(/\/\/.*$|\/\*.*?(\*\/|$)/g, '');
}

const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;
const STRING = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;
const withoutRegex = (line: string) => line.replace(/(^|[=(,:;!&|?{}[\]]\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\[])+\/[a-z]*/g, '$1/re/');

// What part of a line each rule reads. A detector's own pattern sits in a regex literal or a string, and prose
// that names a shortcut sits in a comment; the shortcut itself is code, except where it lives elsewhere.
const SCAN = {
  // a suppression is a comment
  comments: (line: string) => withoutRegex(line.replace(STRING, '""')),
  // a stub's "not implemented" is a string
  strings: (line: string) => (COMMENT_LINE.test(line) ? '' : withoutRegex(line)),
  code: codeOf,
  // a config's setting is a key and a value, often both strings; a line commented out (`//`, `#`, `;`) sets nothing
  config: (line: string) => (/^\s*(\/\/|\/?\*|#|;)/.test(line) ? '' : line),
};

// The configs that decide what a check reports, by file name: a setting there that turns a check off makes it
// pass without the code getting better (ECC's config-protection hook blocks edits to these files outright).
const TSCONFIG = /(^|\/)[tj]sconfig[^/]*\.json$/;
const LINT_CONFIG = /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.?biome\.jsonc?|\.oxlintrc\.json|\.?ruff\.toml|\.flake8|\.pylintrc|pylintrc|\.golangci\.ya?ml|\.rubocop\.yml|\.stylelintrc[^/]*|stylelint\.config\.[cm]?[jt]s|\.markdownlint[^/]*|pyproject\.toml|setup\.cfg|tox\.ini|mypy\.ini|\.mypy\.ini)$/;
const TEST_CONFIG = /(^|\/)((jest|vitest|vite|playwright|karma)\.config\.[cm]?[jt]s|\.mocharc[^/]*|bunfig\.toml|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini)$/;
// A check's script in package.json that cannot fail: a bare echo/true/exit 0, `|| true`, or --passWithNoTests.
const NOOP_SCRIPT = /"(test|lint|typecheck|type-check|tsc|check|ci|verify)(:[\w:-]+)?"\s*:\s*"((echo|true|exit 0)\b[^"]*|[^"]*\|\|\s*(true|exit 0|:)\s*|[^"]*--passWithNoTests[^"]*)"/;

const ADDED: { rule: SlopRule; re: RegExp; files?: RegExp; scan: keyof typeof SCAN }[] = [
  { rule: 'test-skipped', re: /\.(skip|only|todo)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)|\bt\.Skip\(|#\[ignore\]|@(Disabled|Ignore)\b/, scan: 'code' },
  { rule: 'suppression', re: /@ts-(ignore|nocheck|expect-error)|eslint-disable|biome-ignore|#\s*type:\s*ignore|#\s*noqa|\/\/\s*nolint|#!?\[allow\(|@SuppressWarnings/, scan: 'comments' },
  {
    rule: 'swallowed-error',
    re: /catch\s*(\([^)]*\))?\s*\{\s*\}|except(\s+[\w.]+(\s+as\s+\w+)?)?\s*:\s*pass\b|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/,
    scan: 'code',
  },
  { rule: 'type-escape', re: /\bas any\b|:\s*any\b(?![\w$])|<any>/, files: /\.[cm]?tsx?$/, scan: 'code' },
  { rule: 'stub', re: /not implemented|NotImplementedError|unimplemented!\(|todo!\(/i, scan: 'strings' },
  // TypeScript's strict family turned off.
  {
    rule: 'config-weakened',
    re: /"(strict\w*|alwaysStrict|noImplicit\w+|noUnused\w+|noUnchecked\w+|noFallthrough\w+|exactOptionalPropertyTypes|useUnknownInCatchVariables)"\s*:\s*false/,
    files: TSCONFIG,
    scan: 'config',
  },
  // A lint rule set to off (or 0 in ESLint), files or codes the linter is told to skip, mypy's strictness off.
  {
    rule: 'config-weakened',
    re: /[:=,[]\s*["']off["']|"recommended"\s*:\s*false|\b(ignorePatterns|ignores|(extend-)?ignore|per-file-ignores|disable|disable-all|exclude)\b["']?\s*[:=]|^\s*(strict|disallow_\w+|check_untyped_defs|warn_return_any)\s*=\s*false\b|\bignore_errors\s*=\s*true\b/i,
    files: LINT_CONFIG,
    scan: 'config',
  },
  { rule: 'config-weakened', re: /^\s*["']?[\w/@-]+["']?\s*:\s*\[?\s*0\s*[,\]]/, files: /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s)$/, scan: 'config' },
  // Test files the runner is told to skip.
  {
    rule: 'config-weakened',
    re: /\b(testPathIgnorePatterns|modulePathIgnorePatterns|testIgnore|exclude|norecursedirs)\b["']?\s*[:=]|--ignore\b|--deselect\b|passWithNoTests/,
    files: TEST_CONFIG,
    scan: 'config',
  },
  { rule: 'config-weakened', re: NOOP_SCRIPT, files: /(^|\/)package\.json$/, scan: 'config' },
];

export function findSlop(changes: FileChange[]): SlopFinding[] {
  const out: SlopFinding[] = [];
  for (const c of changes) {
    const test = TEST_FILE.test(c.path);
    if (c.deleted) {
      if (test) out.push({ rule: 'test-deleted', path: c.path });
      continue;
    }
    if (test) {
      const lost = c.removed.filter((l) => ASSERTION.test(l)).length - c.added.filter((l) => ASSERTION.test(l)).length;
      if (lost > 0) out.push({ rule: 'test-weakened', path: c.path, line: `${lost} assertion line${lost > 1 ? 's' : ''} removed` });
    }
    if (PROSE.test(c.path)) continue;
    for (const line of c.added) {
      // A line two rules of one kind match (pyproject.toml is a lint and a test config) is one finding.
      const hit = new Set<SlopRule>();
      for (const { rule, re, files, scan } of ADDED)
        if (!hit.has(rule) && (!files || files.test(c.path)) && re.test(SCAN[scan](line))) {
          hit.add(rule);
          out.push({ rule, path: c.path, line: line.trim().slice(0, 120) });
        }
    }
  }
  return out;
}

export const formatFinding = (f: SlopFinding) => `${f.rule} ${f.path}${f.line ? `: ${f.line}` : ''}`;

// Changes from a `git diff -U0` patch (snapshots name every file a call touched, bash included).
export function changesFromPatch(patch: string): FileChange[] {
  const out: FileChange[] = [];
  let cur: FileChange | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line);
      cur = { path: m?.[1] ?? '', added: [], removed: [], deleted: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('deleted file mode')) cur.deleted = true;
    else if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    else if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return out;
}

// Without snapshots: the edit and write calls that completed, as the model sent them.
export function changesFromCalls(events: SessionEvent[]): FileChange[] {
  const out: FileChange[] = [];
  const intents = new Map<string, Extract<SessionEvent, { kind: 'tool_intent' }>>();
  for (const e of events) {
    if (e.kind === 'tool_intent') intents.set(e.callId, e);
    if (e.kind !== 'tool_result' || e.status !== 'completed') continue;
    const i = intents.get(e.callId);
    if (!i || (i.tool !== 'edit' && i.tool !== 'write')) continue;
    const lines = (s: unknown) => (typeof s === 'string' ? s.split('\n') : []);
    const path = String(i.input.path ?? '');
    if (i.tool === 'write') out.push({ path, added: lines(i.input.content), removed: [], deleted: false });
    else {
      const found = editsOf(i.input);
      const edits = 'error' in found ? [] : found;
      out.push({ path, added: edits.flatMap((x) => lines(x.new_text)), removed: edits.flatMap((x) => lines(x.old_text)), deleted: false });
    }
  }
  return out;
}

export const slopReminder = (findings: SlopFinding[]) =>
  `cedia's slop guard flagged changes this run made that often hide a problem instead of fixing it:\n${findings.map((f) => `- ${formatFinding(f)}`).join('\n')}\nRemove each one and fix the cause, or keep it and say in your final report why it is needed. Do not weaken or skip tests to make them pass.`;
