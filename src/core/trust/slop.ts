import type { SessionEvent } from '../types.ts';
import { editsOf } from '../tools/edit.ts';

// The slop guard reads what a run changed and flags the shortcuts an agent takes to look done: tests weakened,
// skipped or deleted, checks silenced, errors swallowed, types escaped, stubs left in place. Each finding is a
// line the run added (or a test it removed), never what the file already had.
export type FileChange = { path: string; added: string[]; removed: string[]; deleted: boolean };
export type SlopRule = 'test-deleted' | 'test-weakened' | 'test-skipped' | 'suppression' | 'swallowed-error' | 'type-escape' | 'stub';
export type SlopFinding = { rule: SlopRule; path: string; line?: string };

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|rs)$/;
// Prose may quote any of these patterns; only code is scanned.
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const ASSERTION = /\b(expect|assert\w*|should)\b|\b(it|test|describe)\s*\(/;

// The code of a line without its comments, strings and regex literals, for rules about code that prose may
// name: "the rule matches: any key" in a comment, or a detector's own pattern, is not a type escape.
export function codeOf(line: string): string {
  if (/^\s*(\/\/|\/?\*)/.test(line)) return '';
  return line
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
    .replace(/(^|[=(,:;!&|?{}[\]]\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\[])+\/[a-z]*/g, '$1/re/')
    .replace(/\/\/.*$|\/\*.*?(\*\/|$)/g, '');
}

const ADDED: { rule: SlopRule; re: RegExp; files?: RegExp; code?: boolean }[] = [
  { rule: 'test-skipped', re: /\.(skip|only|todo)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)|\bt\.Skip\(|#\[ignore\]|@(Disabled|Ignore)\b/ },
  { rule: 'suppression', re: /@ts-(ignore|nocheck|expect-error)|eslint-disable|biome-ignore|#\s*type:\s*ignore|#\s*noqa|\/\/\s*nolint|#!?\[allow\(|@SuppressWarnings/ },
  {
    rule: 'swallowed-error',
    re: /catch\s*(\([^)]*\))?\s*\{\s*\}|except(\s+[\w.]+(\s+as\s+\w+)?)?\s*:\s*pass\b|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/,
  },
  { rule: 'type-escape', re: /\bas any\b|:\s*any\b(?![\w$])|<any>/, files: /\.[cm]?tsx?$/, code: true },
  { rule: 'stub', re: /not implemented|NotImplementedError|unimplemented!\(|todo!\(/i },
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
    for (const line of c.added)
      for (const { rule, re, files, code } of ADDED)
        if ((!files || files.test(c.path)) && re.test(code ? codeOf(line) : line)) out.push({ rule, path: c.path, line: line.trim().slice(0, 120) });
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
