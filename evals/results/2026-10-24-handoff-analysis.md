# Where cedia should hand off (measured 2026-10-24)

Read-only analysis of every cedia session log kept on the owner's Mac (~/.cedia/sessions, the gate runs' temporary home) and the eval result rows in ~/cedia/evals/results. No model calls. Script: handoff_sim.py (in the session scratchpad).

## 1. Context per writer session, by model

| model | sessions | peak p50 | p90 | max | sessions > 60k | tokens added per turn (median) |
|---|---|---|---|---|---|---|
| openrouter/deepseek-v4.1-flash | 564 | 9k | 59k | 125k | 56 | 590 |
| anthropic/claude-haiku-5-5 | 348 | 14k | 24k | 90k | 3 | 1467 |
| opencode-go/deepseek-v4.1-flash | 35 | 24k | 101k | 116k | 6 | 813 |
| anthropic/claude-opus-5-5 | 12 | 13k | 15k | 16k | 0 | 1597 |
| openrouter/claude-haiku-5-5 | 12 | 14k | 22k | 22k | 0 | 1539 |

## 2. Handoffs measured

- anthropic/claude-haiku-5-5 (note): handed off at 90k; note 3590 output tokens; successor's first request 17k; writes over its first 3 turns 19k; first edit at turn 9

Only 1 handoff with both sessions on disk: the eval runs of 2026-10-21/22 that measured handoff at 20k, 30k and 90k kept their logs in temporary homes that are gone, so section 4 uses their result rows instead.

Used in the replay: note 3590 output tokens, successor start 17k, its re-read 1k of extra writes over its first turns.

## 3. Replay of the sessions that grew past 60k, at each model's prices

65 sessions (anthropic/claude-haiku-5-5: 3, opencode-go/deepseek-v4.1-flash: 6, openrouter/deepseek-v4.1-flash: 56). Each one's per-turn growth and output is replayed as it happened, handing off whenever the context passes the threshold. 'none' never hands off.

| priced as | 60k | 80k | 90k | 100k | 115k | 130k | 150k | 200k | none | best | 115k vs best | 150k vs best |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic/claude-haiku-5-5 | $2.85 | $2.92 | $2.99 | $3.29 | $4.08 | $4.73 | $5.06 | $5.16 | $5.16 | 60k | +43.2% | +77.8% |
| anthropic/claude-opus-5-5 | $98.56 | $96.78 | $96.80 | $96.94 | $97.60 | $98.49 | $98.78 | $98.95 | $98.95 | 80k | +0.8% | +2.1% |
| anthropic/claude-sonnet-5-5 | $49.28 | $48.39 | $48.40 | $48.47 | $48.80 | $49.24 | $49.39 | $49.47 | $49.47 | 80k | +0.8% | +2.1% |
| anthropic/claude-fable-5-1 | $227.27 | $216.74 | $213.57 | $211.82 | $211.58 | $211.84 | $211.56 | $211.56 | $211.56 | 200k | +0.0% | +0.0% |
| deepseek-v4.1-flash | $5.45 | $5.20 | $5.13 | $5.08 | $5.08 | $5.08 | $5.08 | $5.08 | $5.08 | 200k | +0.0% | +0.0% |

## 4. Quality and time: runs that handed off against comparable runs that did not (result rows, 2026-10-21/22)

| arm | runs | pass | false-done | handoffs | cost | mean wall |
|---|---|---|---|---|---|---|
| hard-*, Haiku, handoff at 20k | 21 | 19 | 0 | 10 | $0.240 | 82s |
| hard-*, Haiku, no handoff | 21 | 20 | 0 | 0 | $0.187 | 55s |
| wide-*, Haiku, handoff at 30k | 12 | 11 | 0 | 0 | $0.076 | 46s |
| wide-*, Haiku, no handoff | 12 | 12 | 0 | 0 | $0.083 | 39s |
| real-*, Haiku, handoff at 90k | 6 | 5 | 0 | 19 | $1.026 | 665s |
| real-*, Haiku, handoff at 90k, plan-shaped note | 6 | 6 | 0 | 8 | $0.844 | 394s |
| real-*, Haiku, handoff at 90k, changed-files-first note | 6 | 5 | 0 | 16 | $1.156 | 614s |
| real-*, Haiku, no handoff (peaks to 211k, over the 100k price line) | 6 | 6 | 0 | 0 | $1.758 | 381s |
| long three-changes, Haiku, note handoff | 3 | 3 | 0 | 3 | $0.236 | 253s |
| long three-changes, Haiku, server compaction (fixed) | 3 | 3 | 0 | 4 | $0.163 | 218s |
| real-*, Flash, handoff at 90k | 6 | 5 | 0 | 7 | $0.585 | 528s |

- An early handoff (20k on hard-*) cost 28% more, took 49% longer and passed one fewer run: the successor re-reads what it was working on.
- At 90k on real-* Haiku, the handoff runs cost 42-52% less than running past the price line, but took 4-75% longer; the plan-shaped note kept 6/6 and cut the handoffs to 8.
- Server compaction beat the note on the same task: 31% cheaper and 14% faster, 3/3 both (the leaked-args variant, 0/3, was a bug since fixed).
- None of these runs' failures is recorded as a lost detail across a handoff in the result rows; the logs that would show it are gone (section 2).

## 5. Recommendation

| model | sessions used | current default | measured optimum (replay) | current vs optimum | recommendation |
|---|---|---|---|---|---|
| Haiku 5.5 | 3 long Haiku + 62 long Flash traces | 90k (0.9 × the 100k price line) | 60k | +4.9% | Keep 90k. 60k saves 5% in replay but every extra handoff adds time and a re-read; 20-30k measurably hurt. Above 100k Haiku costs 5x, so never go past the line. |
| Opus 5.5 | no long Opus sessions; replay on the 65 traces | 150k | 80-90k | +2.1% (115k: +0.8%) | Lower to about 115k: within 1% of the optimum with fewer handoffs than 80k, and less context rot. Thin data. |
| Sonnet 5.5 | none; replay | 150k | 80-90k | +2.1% (115k: +0.8%) | Same as Opus (same read ratio): about 115k. Thin data. |
| Fable 5.1 | none; replay | 150k | no handoff | 0% | Keep 150k: reads at 0.025x make long context cheap; hand off for quality, not cost. Thin data. |
| DeepSeek Flash | 62 long sessions (OpenRouter 56, opencode-go 6) | 150k | no handoff | 0% | Keep 150k; cost is flat above 100k. |

Prefer server compaction over the note on Claude models (cheaper and faster in the one paired test). The cost curves are flat for every model but Haiku: past the price line Haiku is the only place the threshold matters much for money; elsewhere the threshold is a quality and time choice. Data is thin for Opus, Sonnet and Fable (no session of theirs past 16k on this Mac); remeasure from real cedian use.
