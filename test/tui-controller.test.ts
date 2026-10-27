import { describe, expect, test } from 'bun:test';
import { CediaController } from '../src/clients/tui/controller.ts';
import type { TuiArgs } from '../src/clients/tui/main.ts';

describe('controller skeleton', () => {
  test('constructs and exposes state', () => {
    const args: TuiArgs = { cwd: process.cwd(), model: 'faux', permission: 'workspace', sandbox: 'off', spawn: 'off' } as TuiArgs;
    const c = new CediaController(args);
    expect(c.thread).toBeUndefined();
    expect(c.running).toBe(false);
    expect(Array.isArray(c.messages)).toBe(true);
    expect(typeof c.submit).toBe('function');
    expect(typeof c.command).toBe('function');
    expect(typeof c.abort).toBe('function');
  });
  test('abort is safe when nothing running', () => {
    const args: TuiArgs = { cwd: process.cwd(), model: 'faux', permission: 'workspace', sandbox: 'off', spawn: 'off' } as TuiArgs;
    const c = new CediaController(args);
    expect(() => c.abort()).not.toThrow();
  });
});
