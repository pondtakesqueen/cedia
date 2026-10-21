# Baseline from the pi era

Results of the old cedia (a pi 1.3.0 package) and plain pi on the 8 tasks that existed on 2026-10-18, produced by the old `scripts/scoreboard.mjs` on the owner's machine. File names give the harness and, where present, the model family; the rows do not record which model the default runs used.

| File | Harness | Passed | False-done |
|---|---|---|---|
| `pi-era-cedia.jsonl` | old cedia | 8/8 | 0 |
| `pi-era-cedia-grok.jsonl` | old cedia, Grok | 8/8 | 0 |
| `pi-era-cedia-muse.jsonl` | old cedia, Muse | 8/8 | 0 |
| `pi-era-pi.jsonl` | plain pi | 8/8 | 0 |
| `pi-era-pi-grok.jsonl` | plain pi, Grok | 8/8 | 0 |
| `pi-era-pi-muse.jsonl` | plain pi, Muse | 8/8 | 0 |

Every run passed everything, so this set cannot tell harnesses apart. It stays as a regression floor: the new cedia must also pass all 8. The harder tasks planned for `evals/tasks/` are what will separate harnesses.
