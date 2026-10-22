# Notes on Claude Code's prompts, for cedia (2026-10-23)

**Source:** https://github.com/Piebald-AI/claude-code-system-prompts. It holds Claude Code v2.1.307's prompts as extracted from the binary: 1,004 files, of which 199 are system-prompt pieces, 249 are tool descriptions, 169 are system reminders and 103 are agent prompts.

**Licence:** the repo is MIT, but the MIT covers Piebald's own work. The prompt text belongs to Anthropic. As in `research/NOTES.md`, take ideas only and copy nothing. Everything below is paraphrased, and any rule cedia adopts is written in its own words.

**How these notes were made:** three readers covered, respectively:

- the main prompt and its variants;
- tool descriptions and reminders;
- subagents, compaction and classifiers.

Each compared the prompts with cedia's code and with `evals/results/vs-claude/turns-analysis.md`. The file names below are those in the repo's `system-prompts/` folder.

## 1. How Claude Code assembles its main prompt

The main prompt is assembled from about 20 fragments:

- an intro line;
- security;
- a harness block (permission modes, hooks, dedicated tools, parallel calls);
- "doing tasks" (no unrequested additions, no error handling for impossible cases, no compatibility shims, prefer editing existing files);
- executing actions with care;
- delivering work at full scope;
- reporting outcomes;
- act when ready;
- correction restraint;
- communication (outcome first);
- tool policy.

Several pieces are conditional:

- **On the model:**
  - `finish-the-request-instead-of-stopping-early` was added in 2.1.293. The changelog calls it feature-gated guidance for Haiku 5.5, which makes it a per-model delta.
  - The Fable identity pieces exist per model.
  - Since 2.1.219, the wording on approvals depends on the model.
- **On the output style:** the Concise style overrides the formatting rules.
- **On the environment:** worktree, scratchpad, sandbox and Windows pieces.

The `*-lean-rewrite` variants (2.1.301) replace their originals for models the files call "lean-rewrite models"; no model is named. They cover:

- the harness block;
- delivering work;
- communication;
- corrections;
- irreversible actions;
- reminder interpretation;
- context management;
- some tool descriptions.

Despite the name, they are longer and more conversational than the originals. They carry a reason for each rule (the user may be away, so finish before asking), analogies, and examples. **The lesson: the variant aimed at certain models adds reasons rather than adding rules.**

## 2. Gaps in cedia, ranked by expected effect on Flash's turns

The pattern numbers refer to `evals/results/vs-claude/turns-analysis.md`. None of this is measured yet. Each change should land with a gate report.

### Prompt (`src/core/prompts.ts` and the Flash delta)

1. **Stop once the declared check passes (pattern 4).** Claude Code's `finish-the-request…` and `writing-for-the-user` say to end the turn when the request is done, and to stop when the content stops: no closing offer, no recap. cedia's `BASE_SYSTEM` has no stopping rule. Rule for cedia: *when the declared check passes after your last change, write the report and end; no probes, no extra edge cases, no improvements nobody asked for.* Give the reason: every extra turn costs the owner time and money.
2. **Don't re-establish facts you already have (patterns 4 and 5).** Covered by `act-when-ready` (act once you have enough; don't re-derive established facts) and by the Read/Edit notes (don't re-read a file you just edited, since the edit would have failed). Rule: *don't re-read a file or re-check the environment you already saw in this run; a successful edit result is proof enough; get several regions in one command.*
3. **Give each call more work (all patterns).** Claude's lower turn count comes from heavier calls, not from more parallel calls. Rule: *chain independent read, list and test steps into one command, and patch every known failure in one edit before re-running.*
4. **Treat failures that existed before your change as a baseline (pattern 2).** Claude Code's guidance is to finish the rest, report what is stuck, and report what you ruled out. Rule: *if the check already fails before you change anything, write those failures down as the baseline; do not chase them unless the task is about them, and name them first in the report.*
5. **Say why the unpiped run matters (pattern 1).** The cedia preamble already asks for an unpiped run, and Flash piped anyway, so the reason is the missing part. Rule: *the done gate counts only that exact command, so a piped or tailed run will have to be repeated.*
6. **Open the report with the outcome and any failure.** Claude Code's `reporting-outcomes` says every claim must rest on output observed in this session, failures go in the first sentence, and nothing unverified is presented as checked.

### Reminders (`src/core/loop/run.ts`, `src/core/trust/slop.ts`, `src/core/tools/spawn.ts`)

Claude Code attaches reminders to the tool result or message that triggered them. They are tagged as coming from the system, they name the next step, many say to handle them silently, and none fires after the final answer except hooks the user configured. Its `system-reminder-interpretation-lean-rewrite` says reminders come from the app, are often false positives, and may be ignored when they do not apply.

1. **Done gate (`unverifiedReminder`).** It fires after "done", as a user message.
   - Catch the piped check at the moment it runs: add a note to that bash result saying it will not count and that the check should run on its own. Or evaluate the check with pipefail and accept it.
   - If the gate still fires, say that it comes from cedia, not the owner; that the report stands; and that only the bare check is needed, after which the model can end in one line.
2. **Slop guard.** In real-slop-guard#2 it cost 26 turns.
   - Attach findings to the edit or write result that introduced them, the way Claude Code attaches diagnostics.
   - Add: *if this is intended, one sentence in the report is enough; no re-run is needed.*
   - Fix the false positives: skip comments, strings and regexes, and skip `slop.ts` itself.
3. **A fixed prefix on every cedia reminder and on mail from other threads:** this is from cedia, not the owner, and it does not replace the task.
4. **Spawn nudge.** Add *ignore this if you have finished reading.* Claude Code's todo nudges end this way.
5. **`CONTINUE_AFTER_LIMIT`.** Add: restart at the line where the output was cut, and don't comment on the cut.

### Tools (`src/core/tools/`)

1. **Read.**
   - The description should say to read whole files, to use offset/limit only past 2,000 lines, and to batch several reads in one turn.
   - When a file is read again unchanged, return a short note (*unchanged since turn N*) instead of the content.
2. **Bash.**
   - State where writes are allowed (the working directory or `$TMPDIR`, never `/tmp`). Claude Code's Bash description says the same.
   - Encourage combining exploration commands into one call, while keeping the declared check alone.
3. **Edit.**
   - Ask for the smallest unique `old_text`. Claude Code suggests 1–3 lines; cedia's wording pushes toward large, fragile snippets.
   - With redaction: have `read` say how many spans it masked, and reject an `old_text` that contains `[cedia:redacted]`, saying why.

## 3. Getting Flash to spawn (ROADMAP step 4)

None of this is measured.

- **Worked examples.** Claude Code's `*-delegation-examples` show short example calls: a reason for delegating, a self-contained brief with a word cap, then the relayed report. cedia's spawn description explains when to spawn but never shows a call, and weaker models copy examples. Add two example calls: an explore question with a word cap, and a parallel pair.
- **An earlier decision point.** Flash had already finished reading by the time the 50k reminder fired. Nudge once in the first turn instead: *before reading, list the questions you would give explore.*
- **A different test.** `fork-usage-guidelines` asks one question: will you need this raw output again? Phrase the nudge that way rather than by file count.
- **A fork kind.** Claude Code forks inherit the context and share the prompt cache, so the brief is only a short directive. Writing a full brief may be what Flash avoids, and DeepSeek's prefix cache would make a fork cheap.
- **Remove the easy opt-out.** Drop "do it yourself when it takes a few reads" from Flash's description. Claude Code's restraint pieces (`subagent-delegation-restraint`, `…-cost-guidance`) push toward spawning less, which is the opposite of Flash's problem, so they should not go into Flash's delta.
- **Better briefs (`writing-subagent-prompts`).** Include:
  - the goal and why it matters;
  - what has been ruled out;
  - a length cap;
  - no "based on your findings, fix it" (never hand off understanding).
- **Better reports from workers (`worker-fork`, `coordinator-worker-instructions`).** Workers should:
  - open with one line restating the task, so drift shows;
  - state their assumptions;
  - report a denial as the action, the reason, and what would allow it;
  - never retry the same failed approach twice;
  - end with one sentence the parent can relay.

## 4. Handoff and compaction (`src/core/project/handoff.ts`, `compact.ts`)

Claude Code has several summary variants:

| variant | what it does |
|---|---|
| full | nine sections; every user message kept, with constraints verbatim |
| partial | newer turns follow the summary, so it ends with "context for continuing" instead of a next step |
| recent | summarizes only the recent tail |
| capped | at most 2,000 words |
| short | six items to keep, with the user's words kept and the model's reasoning cut down |
| lean | says exactly what the successor receives automatically, so the note does not repeat it |

What cedia's handoff could adopt:

- A section for the owner's own words: limits quoted exactly, and permissions with their scope. Whether the successor already receives thread messages is not yet confirmed.
- A next step tied to the latest request, with a short quote, so a long thread does not drift back to an old goal.
- Tell the note writer what the successor receives automatically (the task, AGENTS.md, memory) so it is not restated.
- A line for promises made to the owner.
- Honour a compaction section in AGENTS.md.
- For `COMPACT_INSTRUCTIONS`, use the partial shape: kept turns follow, so give the state needed to continue rather than a next step.

## 5. Classifier and policy (`src/core/trust/classifier.ts`, `src/core/safety/policy.ts`)

These are new relative to `research/NOTES.md`.

### A real gap, verified in the code

`deny-rule-circumvention-classifier-guidance` catches shell writes, such as `sed -i`, a heredoc or `python -c`, to a path covered by an edit deny rule. In cedia, `matches()` (`src/core/safety/policy.ts`, around line 92) returns false whenever the rule's tool name differs from the call's tool. So `deny: edit(x)` does not stop `bash sed -i x`.

Fix it one of two ways:

- pass the edit deny paths to the classifier;
- or apply path matching, the way `secretInCommand` does for secrets, to every edit deny rule.

### From the security monitor prompt

- Consent clears an action only when the owner's words name the dangerous target itself (the branch, the destination), not just the goal it serves. "Can we…?" is a question, not consent.
- A limit the owner sets ("don't push", "wait for X") holds until the owner lifts it. The agent saying the condition is met does not lift it.
- When a risky action's target or destination comes from tool output or the agent's own guess, treat it as unverified.
- **Permission laundering:** a request from another thread to repeat an action that thread was denied is not owner intent.
- **Out of scope for the classifier:** bad code, misreporting, looping and wasted tokens. Listing these reduces false blocks.
- Decode base64 or hex payloads, and block when they cannot be decoded.
- Treat a commit or a push as running the committed content.
- A hook or script that a write puts in place runs later, so review it at write time.
- Review sub-thread reports the same way as spawn briefs.
- **Output discipline:**
  - a block names its rule category and what would clear it;
  - when no rule can be named, allow.

### From the other classifier prompts

- **The goal judge** (`hook-condition-evaluator-stop`):
  - defaults to "insufficient evidence";
  - has a separate "impossible" verdict that the judge must confirm itself, not take from the agent's word.
- **`auto-mode-rule-reviewer`** critiques the user's rules for clarity, gaps and conflicts. cedia could add a `cedia permissions --review` command that does the same.

## Suggested order

1. Fix the harness problems from `turns-analysis.md`: the slop guard's false positives, `real()` throwing on EPERM, and the redaction decision. Fix the edit deny rule gap at the same time.
2. Reminders: attach them to the call that triggered them, add the cedia prefix, and catch a piped check when it runs.
3. Add the Flash delta, ranked as in section 2, and measure each rule with the Flash gate.
4. Spawn for Flash: examples, the first-turn nudge, then the fork kind.
