import { hash } from '../hash.ts';
import type { SessionEvent } from '../types.ts';

// A run going round in circles, found from the log alone: the same call getting the same result again and
// again, the same tool failing with the same error, or two calls taking turns with nothing new from either.
// OpenHands, Gemini CLI, OpenCode and Hermes each guard their loop with a check like this (arXiv 2609.00006, §6);
// before it, cedia's only stop was the turn limit, 200 turns on.
export type StuckKind = 'same-call' | 'same-error' | 'alternating';
export type StuckFinding = { kind: StuckKind; tools: string[]; times: number };

// One call and what it got back. `call` covers the tool and its input, `result` the text the model saw.
type Step = { tool: string; call: string; result: string; isError: boolean };

// How many in a row make each pattern. A repeat must also get the same result back, so a test run again after a
// change, or a poll whose output moves, never counts.
export const SAME_CALL = 4;
export const SAME_ERROR = 3;
export const ALTERNATING = 6;

// Waiting is meant to repeat.
const WAITS = new Set(['sleep', 'Monitor']);

function steps(events: SessionEvent[]): Step[] {
  const calls = new Map<string, { tool: string; call: string }>();
  const out: Step[] = [];
  for (const e of events) {
    if (e.kind === 'assistant') {
      for (const b of e.blocks) if (b.type === 'tool_use') calls.set(b.callId ?? b.id, { tool: b.name, call: hash({ tool: b.name, input: b.input }) });
    } else if (e.kind === 'tool_result' && e.status !== 'not_started') {
      const c = calls.get(e.callId);
      if (c && !WAITS.has(c.tool)) out.push({ ...c, result: hash(e.output.text), isError: e.output.isError });
    }
  }
  return out;
}

const same = (a: Step, b: Step) => a.call === b.call && a.result === b.result;

// The pattern the newest calls in `events` end on, if any. Pass only the events since the last stuck reminder, so
// a run that was warned is judged on what it did after.
export function findStuck(events: SessionEvent[]): StuckFinding | undefined {
  const s = steps(events);
  const tail = (n: number) => (s.length >= n ? s.slice(-n) : undefined);
  const calls = tail(SAME_CALL);
  if (calls && calls.every((x) => same(x, calls[0]!))) return { kind: 'same-call', tools: [calls[0]!.tool], times: SAME_CALL };
  const errors = tail(SAME_ERROR);
  if (errors && errors.every((x) => x.isError && x.tool === errors[0]!.tool && x.result === errors[0]!.result))
    return { kind: 'same-error', tools: [errors[0]!.tool], times: SAME_ERROR };
  const pairs = tail(ALTERNATING);
  if (pairs && !same(pairs[0]!, pairs[1]!) && pairs.every((x, i) => same(x, pairs[i % 2]!)))
    return { kind: 'alternating', tools: [pairs[0]!.tool, pairs[1]!.tool], times: ALTERNATING / 2 };
  return undefined;
}

const what = (f: StuckFinding) =>
  f.kind === 'same-call'
    ? `the same ${f.tools[0]} call ${f.times} times in a row, with the same result each time`
    : f.kind === 'same-error'
      ? `${f.tools[0]} failing ${f.times} times in a row with the same error`
      : `the same two calls (${f.tools.join(' and ')}) taking turns ${f.times} times, with nothing new from either`;

export const stuckReminder = (f: StuckFinding) =>
  `cedia sees ${what(f)}. Doing it again will not change the result. Read the last result closely and try a different approach: re-read the file before editing it, change the command, or look at the cause from another side. If the task cannot go on, stop and report what blocks it.`;

// The result of a run that went on repeating itself after the reminder.
export const stuckEnd = (f: StuckFinding) => `cedia stopped the run: it kept repeating itself after a reminder (${what(f)}).`;
