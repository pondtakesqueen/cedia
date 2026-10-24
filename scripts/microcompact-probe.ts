import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SessionLog } from '../src/core/session/log.ts';
import { buildMessages } from '../src/core/context/build.ts';

const path = process.argv[2] ?? ((): string => {
  const { readdirSync, statSync } = require('node:fs');
  const root = `${process.env.HOME}/.cedia/sessions`;
  const files: { p: string; m: number }[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = `${d}/${f}`;
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else if (f.endsWith('.jsonl')) files.push({ p, m: st.mtimeMs });
    }
  };
  walk(root);
  files.sort((a, b) => b.m - a.m);
  return files[0]!.p;
})();

const log = SessionLog.load(path);
const events = log.events;
console.log('session:', path);
console.log('events:', events.length);

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const msgs = buildMessages(events);
const beforeChars = JSON.stringify(msgs).length;
const msg0Before = msgs.length ? JSON.stringify(msgs[0]) : '';

// Count thinking signatures
const thinkingSigs = events.filter((e) => e.kind === 'assistant').flatMap((e) => (e.kind === 'assistant' ? e.blocks : [])).filter((b) => b.type === 'thinking' && b.opaque).length;
console.log('messages:', msgs.length, 'thinking sigs:', thinkingSigs);

// Microcompact: clear tool_result text in events older than keepLastTurns assistant turns.
const KEEP_LAST_TURNS = 2;
// find cutoff index: last N assistant turns
let assistantCount = 0;
const cutoffIndices = new Set<number>();
for (let i = events.length - 1; i >= 0; i--) {
  if (events[i]!.kind === 'assistant') {
    assistantCount++;
    if (assistantCount > KEEP_LAST_TURNS) cutoffIndices.add(i);
  }
}
// mark events before the cutoff turn
let lastKeptAssistant = -1;
for (let i = events.length - 1; i >= 0; i--) {
  if (events[i]!.kind === 'assistant') {
    lastKeptAssistant = i;
    break;
  }
}
// Determine cutoff: index of (KEEP_LAST_TURNS)-th from last assistant
let seen = 0;
let cutoff = 0;
for (let i = events.length - 1; i >= 0; i--) {
  if (events[i]!.kind === 'assistant') {
    seen++;
    if (seen === KEEP_LAST_TURNS + 1) { cutoff = i; break; }
  }
}
console.log('cutoff event index:', cutoff, 'of', events.length);

const cleared: typeof events = events.map((e, i) => {
  if (i >= cutoff) return e;
  if (e.kind !== 'tool_result') return e;
  if (e.output.text.length <= 120) return e;
  return { ...e, output: { ...e.output, text: '[microcompact: tool result cleared]' } };
});

const afterMsgs = buildMessages(cleared);
const afterChars = JSON.stringify(afterMsgs).length;
const msg0After = afterMsgs.length ? JSON.stringify(afterMsgs[0]) : '';

console.log('msg0 hash before:', hash(msg0Before));
console.log('msg0 hash after :', hash(msg0After));
console.log('msg0 identical  :', msg0Before === msg0After);
console.log('chars before:', beforeChars, 'after:', afterChars, 'reduction:', ((1 - afterChars / beforeChars) * 100).toFixed(1) + '%');
console.log('thinking sigs after:', cleared.filter((e) => e.kind === 'assistant').flatMap((e) => (e.kind === 'assistant' ? e.blocks : [])).filter((b) => b.type === 'thinking' && b.opaque).length);
console.log('prefix (first 3 msgs) identical:', JSON.stringify(msgs.slice(0, 3)) === JSON.stringify(afterMsgs.slice(0, 3)));
