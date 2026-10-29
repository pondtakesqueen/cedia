# What Claude Code does on the tasks it wins (2026-10-29)

Question: with the same model (Opus 5.5), Claude Code beat cedia 8 to 1 on blind panels (`../2026-10-28-opus-quality/`, 19 tasks). What does it do differently? This is learned from its behaviour, not from its prompt (AGENTS.md: no prompts from Claude Code or leaked sources).

- Claude Code 2.1.312 was run on four tasks it won: hard-memo-async, hard-csv-stream, hard-sse and hard-shell-split.
  - Command: `claude -p --model opus --output-format stream-json --verbose`, with the eval harness's other flags.
  - The transcripts were read for tool calls. The diffs are kept here as `<task>-cc.diff`.
- cedia ran beside it on Haiku 5.5 at its default effort (`<task>-cedia.diff`). No Anthropic key was available here for cedia on Opus.
- All eight runs pass the visible tests.

| task | Claude Code: calls, output tokens, cost | lines added: Claude Code / cedia |
|---|---|---|
| hard-memo-async | 4, 4129, $0.22 | 95 / 78 |
| hard-csv-stream | 5, 7187, $0.30 | 273 / 165 |
| hard-sse | 3, 1414, $0.13 | 43 / 29 |
| hard-shell-split | 4, 6041, $0.27 | 175 / 130 |

What it shows:
- The tool pattern is the same as cedia's: read every file in one call, write the change in one or two calls, run the tests.
  - Claude Code made no extra exploration calls and did not run a check more often.
  - On hard-sse it did not run the tests at all.
- The difference is in each write. Claude Code's changes are 20 to 65% longer, and the extra lines go to:
  - the cases the doc comment implies;
  - broader tests (all chunk splits, random inputs).
- On hard-shell-split, after the fix, it ran `bun -e` on a handful of adversarial inputs to probe its own parser. The panels kept finding cedia's misses in exactly this kind of case.
- Its output tokens per task were 1.4k to 7.2k, almost all of it reasoning before the write (the stream does not show the thinking text).

Read with the panel data: the gap is reasoning spent before writing, and probing one's own change, not tools or turns. cedia's levers for that are:
- the writer's starting effort (Haiku starts at low; `catalog.ts`);
- the prompt lines that trade checking for fewer turns (`TURN_COST`, `STOP_FRUGAL`, `prompts.ts`).
