import { describe, expect, test } from 'bun:test';
import { planParts, planPrompt, withPlan } from '../src/core/roles.ts';

const part = (files: string, brief: string) => `<part files="${files}">${brief}</part>`;

describe('plan parts', () => {
  test('2 to 4 parts with their own files are kept, with each file list and brief', () => {
    const plan = `Steps first.\n${part('src/a.ts, test/a.test.ts', ' Add a. Check: bun test test/a.test.ts ')}\n${part('src/b.ts', 'Add b.')}`;
    expect(planParts(plan)).toEqual([
      { files: ['src/a.ts', 'test/a.test.ts'], brief: 'Add a. Check: bun test test/a.test.ts' },
      { files: ['src/b.ts'], brief: 'Add b.' },
    ]);
  });

  test('one part, five, a shared file, an empty brief or no files mean no parts', () => {
    expect(planParts(part('a.ts', 'x'))).toEqual([]);
    expect(planParts(['a', 'b', 'c', 'd', 'e'].map((f) => part(f, 'x')).join('\n'))).toEqual([]);
    expect(planParts(part('a.ts, b.ts', 'x') + part('b.ts', 'y'))).toEqual([]);
    expect(planParts(part('a.ts', ' ') + part('b.ts', 'y'))).toEqual([]);
    expect(planParts(part(' , ', 'x') + part('b.ts', 'y'))).toEqual([]);
  });

  test('the planner is asked for parts only when the writer can hand them off', () => {
    expect(planPrompt('t')).not.toContain('<part');
    expect(planPrompt('t', 'alone')).toContain('<part files=');
    expect(planPrompt('t', 'alone')).not.toContain('at the same time');
    expect(planPrompt('t', 'parallel')).toContain('several run at the same time');
  });

  test('the writer is told to hand off the parts only when there are usable ones', () => {
    const two = part('a.ts', 'x') + part('b.ts', 'y');
    expect(withPlan('t', two, 'm', 'alone')).toContain('splits the work into 2 parts');
    expect(withPlan('t', two, 'm', 'alone')).toContain('one after another');
    expect(withPlan('t', two, 'm', 'off')).not.toContain('splits the work');
    expect(withPlan('t', part('a.ts', 'x'), 'm', 'parallel')).not.toContain('splits the work');
    // The parts stay in the plan as written, inside its frame.
    expect(withPlan('t', two, 'm', 'parallel')).toContain(`<plan by="m">\n${two}\n</plan>`);
  });
});
