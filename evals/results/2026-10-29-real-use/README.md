# Tasks shaped like the owner's real prompts (2026-10-29)

The owner's session logs from 2026-10-23 to 10-29 hold 31 prompts, all to Haiku 5.5:

| kind of prompt | share |
|---|---|
| greetings and smoke tests | 71% |
| read-only questions | 13% |
| CI-failure notices from the desktop's PR watcher | 10% |
| run-or-check requests | 6% |

None of these kinds was in `evals/tasks`. Four tasks add them:

| task | what it checks |
|---|---|
| `chat-greeting` | `hi` gets a short answer, does not go to the planner, and changes nothing |
| `ask-readonly` | a question about `cloneState` is answered right (it names both callers and the shallow copy), and the workspace is unchanged |
| `ci-fix-notice` | the PR watcher's wording, with a one-line bug |
| `ci-already-green` | the same wording when the check already passes: run it, change nothing, and say so |

To grade an answer, the runner hands verify the run's final text and stderr as `EVAL_OUTPUT` and `EVAL_STDERR`.

One run of each, with the `-m auto` roles (`--review claude-code:sonnet@high --cedia-arg=--plan=claude-code:opus@low`, Haiku writer):

| task | pass | time | cost (Haiku + plan + review, API price) | plan | review |
|---|---|---|---|---|---|
| chat-greeting | yes | 2.7 s | $0.001 | skipped | skipped |
| ask-readonly | yes | 4.4 s | $0.001 | skipped | skipped |
| ci-fix-notice | yes | 31.8 s | $0.076 | 12 s | approve, 11 s |
| ci-already-green | yes | 26.1 s | $0.064 | 16 s | none (no change) |

Both CI notices were planned. That follows the triage prompt, which plans a fix whose cause is not given, and it cost about $0.05 a notice. These tasks are not in `evals/gate/suite.json`, so the gate's baseline is unchanged.

## The CI notices without a planner: the `ci` profile

The plan above cost most of a CI notice's run. The same two tasks were run three times each in two more setups:

| | runs | pass | mean time | mean cost |
|---|---|---|---|---|
| auto roles, plan and review (above) | 2 | 2 | 29 s | $0.070 |
| Haiku alone, no plan or review (`ci-noprofile.jsonl`) | 6 | 6 | 9 s | $0.001 |
| auto roles with `--profile ci` (`ci-profile.jsonl`): no plan, Sonnet review kept | 6 | 6 | 14 s | $0.012 |

So cedia now ships a `ci` profile for the PR watcher's prompts:
- `planWhen: never`, so the planner is skipped.
- A workspace session.
- Short rules for the fix: run the named check first, and if it passes change nothing and say so; never skip, loosen or rewrite a test to get green.

The review still reads the change when a review role is set. These are one-line fixes, so a failure that needs a plan has not been measured.
