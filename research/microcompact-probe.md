# Microcompact prototype findings (Tier 1 #2)

Prototype: `scripts/microcompact-probe.ts`. Simulates clearing old tool-result text
in a recorded session and rebuilds messages via `buildMessages`.

## Measurements (largest recorded session, 72 events)
- Messages: 16, thinking sigs: 0.
- Naive clear of tool results older than last 2 assistant turns: chars 43281 -> 22425 = 48.2% reduction.
- Message 0 (first user message) hash: identical (2a7e0ca345377b3f) before/after.
- Prefix (first 3 messages) identical: FALSE. Clearing touched early tool results, so the
  cached prefix beyond message 0 changed.
- Baseline cache hit (faux, 5 turns): ~96.6%, 0 misses.

## Safety assessment
- Claude 5.5: UNSAFE. SPEC forbids client-side tool-result clearing because thinking
  signatures bind the unedited prefix; any history edit is a correctness bug, not just
  a cache miss. Even though message 0 is byte-identical, later messages change, so the
  cache prefix breaks and signatures risk invalidation.
- Chat Completions / Responses: token reduction is large (~48%), but the cache prefix
  still changes, so hit rate drops from ~96% to near 0 on the next request after clearing.
- Thinking signatures: none in the sampled session; cannot validate preservation, but the
  prefix change alone is disqualifying.

## Conclusion
Do not implement naive client-side clearing. If pursuing Tier 1 #2, use Anthropic's
server-side context editing (`context_management` clear_tool_uses) on the Claude wire,
or keep the existing handoff/compaction approach. Plan PRs only around server-side
editing, gated to the Anthropic wire, with cache-hash verification in tests.
