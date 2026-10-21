import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMessages } from '../src/core/context/build.ts';
import { hash, stableJson } from '../src/core/hash.ts';
import { rebuildRequest, runPrompt } from '../src/core/loop/run.ts';
import { FAUX_MODEL } from '../src/core/providers/catalog.ts';
import { fauxProvider, text, toolUse, type FauxStep } from '../src/core/providers/faux.ts';
import { SessionLog } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { readTool } from '../src/core/tools/read.ts';
import { hitRatio, type EventOf } from '../src/core/types.ts';

const SYSTEM = 'You are cedia, a coding agent. '.repeat(40);

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'cedia-cache-'));
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), `file ${i}\n`.repeat(20));
  return dir;
}

// 20 model calls: 19 tool-using steps, then a final answer.
function script(): FauxStep[] {
  const steps: FauxStep[] = [];
  for (let i = 0; i < 19; i++)
    steps.push({ blocks: [text(`step ${i}`), i % 2 ? toolUse(`call_${i}`, 'bash', { command: 'ls' }) : toolUse(`call_${i}`, 'read', { path: `f${i % 5}.txt` })] });
  steps.push({ blocks: [text('done')] });
  return steps;
}

describe('cache prefix (offline, faux)', () => {
  test('20 tool-using turns keep the prefix byte-stable and hit >= 90%', async () => {
    const cwd = workspace();
    const log = SessionLog.create();
    const provider = fauxProvider(script());
    const res = await runPrompt({ log, provider, model: FAUX_MODEL, tools: [readTool, bashTool], system: SYSTEM, cwd }, 'look around');
    expect(res.subtype).toBe('success');
    expect(res.numTurns).toBe(20);

    const reqIdx = log.events.flatMap((e, i) => (e.kind === 'request' ? [i] : []));
    const reqs = reqIdx.map((i) => log.events[i] as EventOf<'request'>);
    expect(reqs).toHaveLength(20);
    expect(new Set(reqs.map((r) => r.systemHash)).size).toBe(1);
    expect(new Set(reqs.map((r) => r.toolsHash)).size).toBe(1);

    // Each request's messages extend the previous request's messages unchanged.
    let prev: string[] = [];
    for (const i of reqIdx) {
      const msgs = buildMessages(log.events.slice(0, i)).map(stableJson);
      expect(msgs.slice(0, prev.length)).toEqual(prev);
      prev = msgs;
    }

    // Faux usage counts cached tokens from the prefix it was sent; after the first call the session is >= 90% cached.
    const later = log.events.filter((e): e is EventOf<'assistant'> => e.kind === 'assistant').slice(1);
    const sum = later.reduce((u, e) => ({ ...u, uncached: u.uncached + e.usage.uncached, cacheRead: u.cacheRead + e.usage.cacheRead }), { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    expect(hitRatio(sum)).toBeGreaterThanOrEqual(0.9);
  });

  test('every request can be rebuilt from the log byte for byte', async () => {
    const cwd = workspace();
    const log = SessionLog.create();
    const provider = fauxProvider(script().slice(0, 5).concat([{ blocks: [text('ok')] }]));
    await runPrompt({ log, provider, model: FAUX_MODEL, tools: [readTool, bashTool], system: SYSTEM, cwd }, 'go');
    const reqIdx = log.events.flatMap((e, i) => (e.kind === 'request' ? [i] : []));
    expect(reqIdx.length).toBe(6);
    for (const i of reqIdx) {
      const rebuilt = rebuildRequest(log.events, i, FAUX_MODEL, log.id);
      expect(hash(provider.body(rebuilt))).toBe((log.events[i] as EventOf<'request'>).bodyHash);
    }
    // The faux provider saw exactly those bodies.
    expect(provider.state.bodies.map((b) => hash(b))).toEqual(reqIdx.map((i) => (log.events[i] as EventOf<'request'>).bodyHash));
  });
});
