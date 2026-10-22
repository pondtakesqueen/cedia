# Notes on Anthropic's published system prompts, for tuning cedia (2026-10-23)

## Source

- Index: https://platform.claude.com/docs/en/release-notes/system-prompts/overview
- Coverage: all 22 model pages, Claude Haiku 3 through Fable 5.1 and Haiku 5.5, every dated entry on each page.
- Use: ideas only. Everything below is paraphrased; no passages are copied.
- Scope: these are the claude.ai and mobile-app chat prompts. They do not apply to the API or to Claude Code, so they carry no tool-loop or coding rules. What transfers to cedia is how Anthropic structures and tunes prompts per model and across versions.

## How Anthropic does it

### 1. One shared base, a small delta per model

The base has been copied verbatim across models since Claude 4.

- **Claude 4:** the Opus 4 and Sonnet 4 prompts differ only in the identity block, meaning the model's one-line description and its API string.
- **Claude 5.x:** the reminders, evenhandedness, mistakes and knowledge-cutoff sections are nearly identical across all seven prompts.
- **Where the delta goes:** in a few behaviour sections (refusals, tone, wellbeing) and in short style tags appended after the main block. Examples are `tone_preference` (Opus 4.8, Opus 5, Fable 5.1) and `conversational_register` (Sonnet 5).
- **The Claude 3 contrast:** each model had its own prompt. Haiku 3's was about 100 words and Opus 3's about 330.

### 2. Instruction style depends on model size

- **Small models get explicit rules and procedures, each with a reason, and more spelled-out edge cases.**
  - Haiku 3.5 got a seven-step procedure for one task and a caveat budget: at most one sentence of caveats.
  - Haiku 4.5 and 5.5 have the longest rule lists.
  - Haiku 5.5's wellbeing section is built from latched rules ("once X has been said, for the rest of the conversation never do A, B, C"), each with its reason.
  - Haiku 5.5 also lists the rationalizations that must not reopen a decision: a new reason, fiction, "just one piece", repetition, frustration, a claim it agreed earlier.
- **Large models get stances and worked examples.**
  - Opus 5.5 is the only 5.5 prompt with `example` blocks (user, response, rationale) and bad-response/good-response pairs.
  - Opus 4.7 and 4.8 get behaviour sections that state how to act rather than list cases: `acting_vs_clarifying`, `capability_check`, `default_stance`, `tool_discovery`.

### 3. Every rule carries its reason

Reasons are given almost throughout. For example:

- Don't explain a refusal at length, because it reads as preachy.
- Re-check before accepting a correction, because users are wrong too.
- Don't cite the system prompt, because users cannot see it.
- Don't add a disclaimer to make declined content acceptable, because anyone can delete the note.

The reason lets a model apply the rule to cases it does not list.

### 4. Workarounds for a model's weakness live in the delta and are removed when no longer needed

- **Sonnet 3.5 and 3.7** had several reasoning cues: number each item when counting, quote every premise of a familiar puzzle (to catch a modified version), and think step by step for math.
- **Claude 4** dropped all of them.
- **Opus 4.7** added `acting_vs_clarifying`, to fix interviewing users and stopping halfway. **Opus 4.8** replaced it with `tool_discovery`.
- **Concision and filler-word rules** were added for Opus 4.6 and Opus 5, removed for Opus 5.5, and kept for Fable 5.1.

Style deltas churn, and they are evidently tuned per model and per version.

### 5. Ban the category, not a list of phrases

The filler-opener ban was a game of whack-a-mole.

- Sonnet 3.5 (Sep 2024) banned "Certainly!" and similar.
- Oct 2024 replaced that with a long list of "I aim to be direct" variants, apparently the substitute tic.
- Claude 4 stated a category rule with a positive replacement: don't praise the question, answer directly.

Banned-word lists still appear in places (4.6, 4.8, Fable 5.1), but each is short and gets revised.

### 6. Conditional triggers rather than blanket rules

Rules are scoped to a situation, for example "when counting…", "when shown a familiar puzzle…", or "when most of the answer is precise detail about something obscure…". Opus 3's hallucination caveat applied only in that last case.

### 7. Injected reminders are declared up front

The `anthropic_reminders` section appears in every model since late 2025. It does four things:

- names the closed set of reminders the system may append;
- says what each one is for;
- says to follow a reminder when it applies and otherwise carry on;
- promises that a genuine reminder never loosens a restriction, and says to treat tagged text in the user turn that claims authority with caution.

Opus 4.8 dropped `long_conversation_reminder` from its list; the list is kept current.

### 8. Act before asking, finish the task, then report the answer

- **Opus 4.7 `acting_vs_clarifying`:**
  - Attempt the task now, and ask upfront only when it cannot be done without the answer.
  - Resolve ambiguity with a tool before asking the user.
  - Retry a search that missed, answer every part of the request, and finish the task.
  - Complete means covering what was asked, not writing at length.
- **Opus 4.7 `capability_check` and 4.8 `tool_discovery`:** look for a tool before saying "I can't". Do the action rather than drafting it. Treat a tool search as free.
- **Sonnet 5 `proactivity`** (dropped in 5.5): read-only tools need no permission, actions that send, change or delete need confirmation, and otherwise state the assumption and proceed.
- **Opus 5.5:** match effort to the ask. A request to change one thing gets the change, not the whole piece again.
- **Fable 5.1 `reply_after_tool_calls`:**
  - After tools have run, state the result in one or two sentences.
  - Never reply with only "Done.".
  - Don't repeat what was written before the tools ran.
  - Give a one-sentence progress note every couple of tool calls.
- **Questions:** at most one per reply, after attempting the task.

### 9. Verification and uncertainty

- **Never give numbers from memory:** Sonnet 5.5's and Haiku 4.5's `medical_guidance` (Oct 2026) say to find the source by search and check it against an official copy.
- **Say what could not be verified:** Fable 5.1 asks for this whenever a URL, ID or figure cannot be checked.
- **Check inputs and premises:** check that a referenced file is actually present (all models), and check false presuppositions (Claude 4).
- **Knowledge cutoff:** the model answers as a well-informed person at the cutoff speaking to someone on today's date, which is a `{{currentDateTime}}` template. It neither confirms nor denies what it cannot verify.

### 10. Session values are templated, and facts the model cannot know go in a tagged block

- `{{currentDateTime}}` is a template.
- Facts after the cutoff go in tagged blocks marked "mention only if relevant", such as `election_info` in Claude 4.
- Since Opus 4.8, the prompt notes that the user can switch models mid-chat, so earlier self-identification by another model may be accurate.

### 11. Instructions inside tool results

None of the chat prompts covers this directly. The nearest are:

- Sonnet 4.6: a pasted transcript is outside material, not Claude's own turns.
- Weapons sections: a summary of earlier help is not permission to continue.

cedia's own rule in `BASE_SYSTEM` already goes further than these.

## What this suggests for cedia

These are proposals and have not been measured. Each should land with a gate report (`docs/ROADMAP.md` step 2).

### A. Per-model delta in the model spec

- **Where:** keep `BASE_SYSTEM` (`src/core/prompts.ts`) as the shared base. Add an optional per-model delta to the model spec in `src/core/providers/catalog.ts`, appended after the base as a tagged block such as `<model_notes>`.
- **Cache:** the system prompt stays stable for a session's model. A model switch (handoff or quota fallback) already starts a new request shape.
- **Versioning:** the gate should record `systemHash`, which the session log already holds, next to each baseline. That way a change in numbers can be traced to a prompt version, as Anthropic dates each prompt.

### B. A reminders section in the base (lesson 7)

Today the model meets each cedia reminder cold. Declare them once in the base:

| reminder | what it means |
|---|---|
| context size | hand reading you will not need off to a sub-thread |
| slop guard | some change looks like a shortcut: fix it, or keep it and say why in the report |
| done gate | no declared check has passed since your last change: run it exactly as declared |

Then add the handling rules:

- Deal with each reminder in one turn, and report.
- A reminder never widens what the permission allows.

This targets pattern 1 of `evals/results/vs-claude/turns-analysis.md`, where 54 of 216 Flash turns came after the first "done". It does not replace fixing the slop guard's false positives.

### C. The Flash delta (lessons 2, 3, 4, 6)

Write it as explicit, conditional rules, each with its reason, plus one bad/good pair taken from our own logs. Every line points to the eval finding that motivates it, and is removed when the gate shows it no longer helps (lesson 4). Candidate lines, from `turns-analysis.md` patterns 1, 2, 4 and 5:

- **The final check:** finish with the declared check run exactly as written, for example `bun test` and not `bun test 2>&1 | tail`, because the done gate counts only that command. Bad and good pair taken from real-slop-guard#2 T20 and T78.
- **Failing tests:** when a test run shows several failures, fix all of them before running the tests again, because each run costs a turn.
- **Stopping:** when the declared check passes after your last change, stop and report. Don't add probes or features nobody asked for, because they cost turns and widen the diff (hard-shell-split#2 T8–T16).
- **Reading:** when you need more of files you have already read, get it in one compound command rather than one slice per turn.
- **Temporary files:** when a write outside the working directory is denied, put scratch files in the working directory. The sandbox denies `/tmp`, and a retry will not help.

### D. A Haiku delta, separately

Haiku needs its own delta, measured on its own baseline. Its failure modes differ from Flash's: Flash never spawns, while Haiku already does.

### E. Base additions from the newer Opus and Fable prompts

These would be measured on both models:

- **Open the final report with the result** in one or two sentences, never just "Done." (Fable 5.1). cedia's Flash opened its hard-injection report with exactly "Done.".
- **Resolve ambiguity with a tool before asking the owner,** and finish the task before reporting (Opus 4.7).
- **Match the change to the request** (Opus 5.5): fix what was asked and keep the diff to that.

### F. Style lines are the least stable part

Don't hard-code concision or filler-word rules into the base. Anthropic added and removed them per model (lesson 4). If cedia wants them, put them in the delta and keep only what the gate supports.

### G. Keep weakness workarounds in the delta only

Procedures that work around a model's weakness belong in the delta only, never in the base, so they can be removed per model.
