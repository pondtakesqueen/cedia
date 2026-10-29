# Telling the model a value was redacted (2026-10-29)

Problem: cedia replaces values that look like secrets in tool results with `[cedia:redacted]` (`src/core/safety/secrets.ts`), and gave no explanation. On hard-redact-bugs, whose test file is full of fake keys, Haiku sometimes took the placeholders for missing test inputs. It then gave up: "the test inputs need to be restored to their real values". It failed both gate runs on 9b8c332 this way (`../2026-10-29-karpathy-lines/README.md`).

Change: a result with redactions ends with a cedia note (`redactedNote`, `src/core/loop/run.ts`). The note says:
- how many values were hidden;
- that the file or output still holds them, and they may be a test's fake fixtures;
- to work from what the code does with them and to edit around them;
- that an edit or command containing the placeholder is denied.

The note is part of the logged result, so what the model sees is in the session log.

Haiku alone, hard-redact-bugs (`bun evals/run.ts --harness cedia --model opencode-go/claude-haiku-5-5 --only hard-redact-bugs`):

| | runs | passed | cost per run | wall time |
|---|---|---|---|---|
| before, 9b8c332 (`before.jsonl`) | 7 | 5 | $0.0083 | 48 s |
| with the note (`note.jsonl`) | 8 | **8** | $0.0069 | 41 s |

- The two gate runs on 9b8c332 also failed, which makes it 5 of 9 before.
- Runs of the same task on 6b8ad40 passed 8 of 8, so the failure comes and goes. The note removes the way it failed, at no cost.
