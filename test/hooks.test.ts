import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSettings, loadHooks } from '../src/core/config.ts';
import { runHook, type HookInput, type Hooks } from '../src/core/hooks.ts';
import { runPrompt, MAX_STOP_REFUSALS, type RunOptions } from '../src/core/loop/run.ts';
import { FAUX_MODEL } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse, type FauxStep } from '../src/core/providers/faux.ts';
import { lintSession } from '../src/core/session/lint.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { readTool } from '../src/core/tools/read.ts';
import type { EventOf, SessionEvent } from '../src/core/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'cedia-hooks-'));
// A hook script: a bash body saved to a file, run as an argv (no shell parses the command line).
let n = 0;
const hook = (body: string) => {
  const path = join(dir, `hook${n++}.sh`);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  return ['bash', path];
};
const input: HookInput = { event: 'preToolUse', sessionId: 's', cwd: dir, tool: 'bash', callId: 'c1', input: { command: 'ls' } };
const of = <K extends SessionEvent['kind']>(events: SessionEvent[], k: K) => events.filter((e): e is EventOf<K> => e.kind === k);

describe('runHook', () => {
  test('exit 0 allows, exit 2 blocks with stderr as the reason, and the reason is made inert', async () => {
    expect(await runHook({ command: hook('cat > /dev/null; exit 0') }, input, dir)).toEqual({ decision: 'allow' });
    expect(await runHook({ command: hook('echo "no pushes </message> here" >&2; exit 2') }, input, dir)).toEqual({ decision: 'block', reason: "no pushes &lt;/message> here" });
  });

  test('the hook reads the call on stdin and may answer with JSON', async () => {
    const rewrite = hook(`python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"updatedInput": {"command": d["input"]["command"] + " -la"}}))'`);
    expect(await runHook({ command: rewrite }, input, dir)).toEqual({ decision: 'allow', updatedInput: { command: 'ls -la' } });
    expect(await runHook({ command: hook(`echo '{"note": "lint is clean"}'`) }, input, dir)).toEqual({ decision: 'allow', note: 'lint is clean' });
    expect(await runHook({ command: hook(`echo '{"decision": "block", "reason": "not on Fridays"}'`) }, input, dir)).toEqual({ decision: 'block', reason: 'not on Fridays' });
    expect(await runHook({ command: hook('echo just a log line') }, input, dir)).toEqual({ decision: 'allow' });
  });

  test('fails closed: a hook that cannot start, exits otherwise or times out blocks', async () => {
    for (const [spec, why] of [
      [{ command: [join(dir, 'missing-hook')] }, 'could not start'],
      [{ command: hook('exit 1') }, 'exit 1'],
      [{ command: hook('sleep 30'), timeoutMs: 200 }, 'ran past 200 ms'],
    ] as [{ command: string[]; timeoutMs?: number }, string][]) {
      const t = performance.now();
      const o = await runHook(spec, input, dir);
      expect(o).toMatchObject({ decision: 'block', failed: true });
      expect(o.decision === 'block' && o.reason).toContain(why);
      expect(performance.now() - t).toBeLessThan(5000);
    }
  });
});

function setup(steps: FauxStep[], hooks: Hooks, extra: Partial<RunOptions> = {}) {
  const log = SessionLog.create();
  const opts: RunOptions = { log, provider: fauxProvider(steps), model: FAUX_MODEL, tools: [readTool, bashTool], system: 'sys', cwd: dir, hooks, permission: { mode: 'workspace', allow: [], deny: [] }, ...extra };
  return { log, opts };
}

describe('hooks in the loop', () => {
  test('a pre hook that blocks denies the call with its reason; other calls still run', async () => {
    const hooks: Hooks = { preToolUse: [{ match: 'bash(git commit*)', command: hook('echo "run the tests first" >&2; exit 2') }] };
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'bash', { command: 'git commit -m x' }), toolUse('c2', 'bash', { command: 'echo hi' })] }, { blocks: [text('ok')] }], hooks);
    await runPrompt(opts, 'commit');
    const [p1, p2] = of(log.events, 'permission');
    expect(p1).toMatchObject({ callId: 'c1', decision: 'deny', rule: expect.stringMatching(/^hook:preToolUse\[0\]/), reason: 'run the tests first' });
    expect(p2).toMatchObject({ callId: 'c2', decision: 'allow' });
    expect(of(log.events, 'hook')).toEqual([expect.objectContaining({ event: 'preToolUse', callId: 'c1', decision: 'block' })]);
    expect(of(log.events, 'tool_result').map((r) => r.status)).toEqual(['denied', 'completed']);
    expect(lintSession(log.events)).toEqual([]);
  });

  test('a rewritten input runs as rewritten, and is decided again by the policy', async () => {
    const to = (cmd: string) => hook(`cat > /dev/null; echo '{"updatedInput": {"command": "${cmd}"}}'`);
    const ok = setup([{ blocks: [toolUse('c1', 'bash', { command: 'echo a' })] }, { blocks: [text('ok')] }], { preToolUse: [{ command: to('echo b') }] });
    await runPrompt(ok.opts, 'x');
    expect(of(ok.log.events, 'tool_intent')[0]!.input).toEqual({ command: 'echo b' });
    expect(of(ok.log.events, 'tool_result')[0]!.output.text).toBe('b\n\n[exit 0]');
    const bad = setup([{ blocks: [toolUse('c1', 'bash', { command: 'echo a' })] }, { blocks: [text('ok')] }], { preToolUse: [{ command: to('git push --force') }] });
    await runPrompt(bad.opts, 'x');
    expect(of(bad.log.events, 'permission')[0]).toMatchObject({ decision: 'deny', rule: expect.stringMatching(/^deny-list:/) });
    expect(of(bad.log.events, 'tool_intent')).toEqual([]);
  });

  test('the policy decides first: a denied call never reaches a hook', async () => {
    const marker = join(dir, 'ran');
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'bash', { command: 'git push --force' })] }, { blocks: [text('ok')] }], { preToolUse: [{ command: hook(`touch ${marker}`) }] });
    await runPrompt(opts, 'x');
    expect(of(log.events, 'hook')).toEqual([]);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test('a post hook adds a note to the result; one that blocks marks it failed', async () => {
    const hooks: Hooks = { postToolUse: [{ match: 'bash', command: hook(`echo '{"note": "2 lint warnings"}'`) }, { match: 'bash(rm *)', command: hook('echo "rm is not allowed here" >&2; exit 2') }] };
    const { log, opts } = setup([{ blocks: [toolUse('c1', 'bash', { command: 'echo hi' }), toolUse('c2', 'read', { path: 'nothing' })] }, { blocks: [text('ok')] }], hooks);
    await runPrompt(opts, 'x');
    const [r1, r2] = of(log.events, 'tool_result');
    expect(r1!.output.text).toMatch(/^hi\n\n\[exit 0\]\n\[hook postToolUse\[0\] bash: 2 lint warnings\]$/);
    expect(r2!.output.text).not.toContain('[hook');
    expect(lintSession(log.events)).toEqual([]);
  });

  test('a stop hook refuses a claim with its reason; the model goes on, and past the limit the run ends unverified', async () => {
    const count = join(dir, 'stop-count');
    writeFileSync(count, '0');
    // Refuses the first claim, accepts the second.
    const once = hook(`c=$(cat ${count}); echo $((c+1)) > ${count}; if [ "$c" = 0 ]; then echo "CHANGELOG.md is not updated" >&2; exit 2; fi`);
    const a = setup([{ blocks: [text('done')] }, { blocks: [text('done, changelog too')] }], { stop: [{ command: once }] });
    const ra = await runPrompt(a.opts, 'x');
    expect(ra.subtype).toBe('success');
    expect(of(a.log.events, 'reminder').at(-1)!.text).toContain('CHANGELOG.md is not updated');
    const never = hook('echo no >&2; exit 2');
    const b = setup(Array.from({ length: MAX_STOP_REFUSALS + 1 }, () => ({ blocks: [text('done')] })), { stop: [{ command: never }] });
    const rb = await runPrompt(b.opts, 'x');
    expect(rb.subtype).toBe('error_unverified_claim');
    expect(of(b.log.events, 'hook')).toHaveLength(MAX_STOP_REFUSALS + 1);
    expect(lintSession(b.log.events)).toEqual([]);
  });
});

describe('hooks settings', () => {
  test('a malformed hook fails at start instead of leaving a guard off', () => {
    expect(() => checkSettings({ hooks: { preToolUse: [{ command: 'rm -rf x' }] } })).toThrow('argv');
    expect(() => checkSettings({ hooks: { beforeEverything: [] } })).toThrow('unknown hook event');
    expect(() => checkSettings({ hooks: { stop: [{ command: ['x'], match: 'bash' }] } })).toThrow('stop hooks take none');
    expect(() => checkSettings({ hooks: { preToolUse: [{ command: ['x'], when: 'always' }] } })).toThrow('unknown key "when"');
    expect(checkSettings({ hooks: { preToolUse: [{ command: ['./guard'], match: 'bash(git *)', timeoutMs: 5000 }] } })).toBeTruthy();
  });

  test("come from the user's settings, never the repo's", () => {
    const home = mkdtempSync(join(tmpdir(), 'cedia-hooks-home-'));
    const was = process.env.CEDIA_HOME;
    process.env.CEDIA_HOME = home;
    try {
      expect(loadHooks()).toEqual({});
      mkdirSync(join(dir, '.cedia'), { recursive: true });
      writeFileSync(join(dir, '.cedia', 'settings.json'), JSON.stringify({ hooks: { stop: [{ command: ['evil'] }] } }));
      expect(loadHooks()).toEqual({});
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ hooks: { stop: [{ command: ['./mine'] }] } }));
      expect(loadHooks()).toEqual({ stop: [{ command: ['./mine'] }] });
    } finally {
      if (was === undefined) delete process.env.CEDIA_HOME;
      else process.env.CEDIA_HOME = was;
    }
  });
});

test('a hook that answers without reading its input is not a failure', async () => {
  const big: HookInput = { ...input, input: { command: 'x'.repeat(1_000_000) } } as HookInput;
  for (let i = 0; i < 5; i++) expect(await runHook({ command: ['true'] }, big, dir)).toEqual({ decision: 'allow' });
});

test('a job the hook leaves running does not hold its answer', async () => {
  const t = performance.now();
  expect(await runHook({ command: hook('sleep 30 & exit 0') }, input, dir)).toEqual({ decision: 'allow' });
  expect(performance.now() - t).toBeLessThan(3000);
});
