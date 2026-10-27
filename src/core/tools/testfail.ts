import { MAX_SHELL_OUTPUT_CHARS } from './registry.ts';

// Failures-only summaries for test-runner output: when a long check fails, the model needs the failures, not
// the passing middle. The whole output still goes to the spill file; this picks what rides the result.
const RUNNER = /\b(pytest|go test|bun test|npm (t|test)\b|npx vitest|vitest|jest|deno test|cargo test|tsc(\s|$)|mypy|ruff|golangci-lint)\b/;

// A line worth keeping: a failure marker, an assertion diff, or an error with a location.
const SIGNAL =
  /FAIL|✗|×|⨯|failed|FAILED|Error\b|error:|AssertionError|Expected|Received|panic|Traceback|✘|not ok\b|ERR\b/i;

const CONTEXT = 2;

// The summary lines of a passing run live at the end (counts), so the tail is always kept whole.
const TAIL = 12;

export function isTestCommand(command: string): boolean {
  return RUNNER.test(command);
}

// The failures of a long test output within max characters, or undefined when the command is no test runner,
// nothing matches, or it already fits. The caller appends where the whole output went.
export function summarizeTestFailures(command: string, text: string, max = MAX_SHELL_OUTPUT_CHARS): string | undefined {
  if (!isTestCommand(command) || text.length <= max) return undefined;
  const lines = text.split('\n');
  const keep = new Array<boolean>(lines.length).fill(false);
  let hits = 0;
  lines.forEach((line, i) => {
    if (!SIGNAL.test(line)) return;
    hits++;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = true;
  });
  if (!hits) return undefined;
  for (let i = Math.max(0, lines.length - TAIL); i < lines.length; i++) keep[i] = true;
  const out: string[] = [];
  let hidden = 0;
  let kept = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      out.push(lines[i]!);
      kept += lines[i]!.length + 1;
    } else hidden++;
  }
  // Everything matched: nothing to cut unless it still overflows.
  if (!hidden && kept <= max) return undefined;
  let body = out.join('\n');
  if (kept > max) body = `${body.slice(0, Math.floor(max / 2))}\n\n[...]\n\n${body.slice(-Math.floor(max / 2))}`;
  return hidden ? `${body}\n\n[... ${hidden} lines not shown ...]` : body;
}
