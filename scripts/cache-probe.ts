// Measures prompt-cache hits on a real model: a tool-using session of N turns, repeated R times.
// usage: bun scripts/cache-probe.ts --model <ref> [--turns 20] [--runs 3]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { attributeMisses } from '../src/core/context/cache.ts';
import { runPrompt } from '../src/core/loop/run.ts';
import { BASE_SYSTEM, preamble } from '../src/core/prompts.ts';
import { resolveModel } from '../src/core/providers/catalog.ts';
import { fauxProvider } from '../src/core/providers/faux.ts';
import { missingKeyNote } from '../src/core/providers/http.ts';
import { providerFor } from '../src/core/providers/index.ts';
import { SessionLog, sessionPath } from '../src/core/session/log.ts';
import { bashTool } from '../src/core/tools/bash.ts';
import { readTool } from '../src/core/tools/read.ts';

const { values } = parseArgs({ options: { model: { type: 'string' }, turns: { type: 'string', default: '20' }, runs: { type: 'string', default: '3' } } });
if (!values.model) throw new Error('--model is required');
const model = resolveModel(values.model);
const keyNote = missingKeyNote(model);
if (keyNote) console.error(keyNote);
const turns = Number(values.turns);

const runs = [];
for (let r = 0; r < Number(values.runs); r++) {
  const cwd = mkdtempSync(join(tmpdir(), 'cedia-probe-'));
  for (let i = 1; i < turns; i++) writeFileSync(join(cwd, `part${String(i).padStart(2, '0')}.txt`), `part ${i}: the value is ${i * 7 % 13}\n`);
  const id = crypto.randomUUID();
  const log = SessionLog.create({ id, path: sessionPath(cwd, id) });
  const result = await runPrompt(
    { log, provider: model.wire === 'faux' ? fauxStand(turns) : providerFor(model), model, tools: [readTool, bashTool], system: BASE_SYSTEM, preamble: preamble(cwd), cwd, maxTurns: turns + 3, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) },
    `There are ${turns - 1} files named part01.txt to part${String(turns - 1).padStart(2, '0')}.txt. Read them one at a time, in order, with one read call per turn (do not batch them). Then reply with the sum of all values.`,
  );
  const rows = attributeMisses(log.events, { minTokens: model.caps.cacheMinTokens });
  const later = rows.slice(1);
  const input = later.reduce((s, r) => s + r.input, 0);
  const read = later.reduce((s, r) => s + r.cacheRead, 0);
  runs.push({ run: r + 1, subtype: result.subtype, requests: rows.length, hitAfterFirst: input ? read / input : 0, costUsd: result.costUsd, misses: rows.filter((x) => x.cause && x.cause !== 'cold'), log: log.path });
}

const hits = runs.map((r) => r.hitAfterFirst);
console.log(JSON.stringify({ model: model.ref, turns, runs, mean: hits.reduce((a, b) => a + b, 0) / hits.length, min: Math.min(...hits), max: Math.max(...hits) }, null, 2));

// Offline stand-in that behaves like a model following the probe prompt, so the script itself can be checked.
function fauxStand(n: number) {
  return fauxProvider((_req, state) =>
    state.callCount < n
      ? { blocks: [{ type: 'tool_use', id: `c${state.callCount}`, name: 'read', input: { path: `part${String(state.callCount).padStart(2, '0')}.txt` } }] }
      : { blocks: [{ type: 'text', text: 'done' }] },
  );
}
