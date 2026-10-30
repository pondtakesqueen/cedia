// The skills that come with cedia, so a session in any repository has them without an install. Each is cedia's own
// words (never another client's prompt: AGENTS.md) and is `/`-only, so it adds nothing to the first turn of a session
// that does not ask for it. A user's, repository's or plugin's skill of the same name wins.

export type BuiltinSkill = { name: string; description: string; argumentHint?: string; text: string };

// /init: write or trim a repository's AGENTS.md. The rules follow Anthropic's public guidance on instruction files
// (code.claude.com/docs/en/memory, "Write effective instructions"; /en/best-practices, "Keep CLAUDE.md short"):
// under 200 lines, headings and bullets, concrete lines, only what the code does not already say.
const INIT = `Write this repository's AGENTS.md, or make the one it has shorter and more exact. Every session in the repository loads it, so each line costs attention on every task: keep only what an agent would get wrong without it.

## 1. Read before you write

- Read the instruction files that exist: AGENTS.md and CLAUDE.md at the root and in subdirectories, CLAUDE.local.md, .cursorrules, .github/copilot-instructions.md.
- Find how work is confirmed here: the package manifest's scripts, the CI workflow, the test runner's config, the linter and formatter config, a Makefile or justfile. Read the README for setup steps.
- Look for what misleads: an old pattern used widely that new code must not copy, a directory that looks unused but is live, a generated file that must not be edited by hand, a step that needs an environment variable or a service.
- Run the cheapest of the commands you found (a single test file, the typecheck) when the permission mode allows it, so the file names commands that work. Say which ones you could not run.

## 2. Decide what goes in

Put in:
- The exact commands to install, build, typecheck, lint and test, and how to run one test file or one test.
- The places where the code misleads, found above.
- Decisions the code does not show: the error helper or logger to use, how releases or deploys happen, what needs a person's review.
- Rules the owner has had to give more than once.

Leave out:
- The folder tree, the dependency list, and the language's or framework's usual conventions: an agent reads those from the code.
- Advice that fits any repository ("write clean code", "test your changes", "be careful").
- Anything that holds only for one task. Point to a skill or a doc for it instead.

## 3. Shape

- Under 200 lines; a small repository needs far fewer. Short sections under headings (Commands, Conventions, Gotchas is a good start), one bullet per rule.
- Each line concrete enough to check: "Run \`bun test\` before committing", not "Make sure tests pass"; "API handlers live in src/api/handlers/", not "Keep files organized".
- No capitals, IMPORTANT or repetition for emphasis. A rule that may never be broken belongs in a test, a CI check or a hook; name the check in the file and suggest adding it.
- A long reference (every CLI flag, an architecture tour) goes in a file under docs/ that AGENTS.md links to. Do not pull it in with an @import: imported files load into every session too.
- One person's preferences (their name, reply language, editor) do not go in the shared file; say they belong in the user's own instructions.
- No two lines may contradict each other or another instruction file the repository keeps.

## 4. Write

- No AGENTS.md yet: write it. If a CLAUDE.md holds the instructions, move them into AGENTS.md and leave CLAUDE.md as the single line \`@AGENTS.md\`, so every client reads one file.
- An AGENTS.md already there: do not rewrite it wholesale. Make the cuts and corrections, and say for each removed line why (the code says it, too general, stale: it names a file or command that no longer exists).
- In a read-only session, write nothing: give the proposed file, or the changes as a diff.
- Some things only the owner knows (a deploy step, a rule they keep repeating). Ask for them once if you can ask; otherwise list them as open questions at the end of your reply.

## 5. Finish

Check the file with \`wc -l AGENTS.md\` and by opening every path it names. Report the line count, the commands you ran and whether each passed, and the command a run here could give to \`--check\` so the done gate runs it.

## Examples

- \`/init\` in a Bun project with no instruction file: AGENTS.md of about 20 lines, with \`bun install\`, \`bun test\`, \`bun test path/to/file.test.ts\`, \`bun run typecheck\`, and a Gotchas line for the test that needs \`DATABASE_URL\` (from .env.example).
- \`/init\` where AGENTS.md is 400 lines: the same file at about 120, the folder tour and the generic advice cut, the flag reference moved to docs/CLI.md and linked, and a list of what was cut and why.
- \`/init the release steps\`: only the release section changes; the text after the command says what to focus on.

## Troubleshooting

- No test or build command can be found: say so, and ask the owner rather than invent one.
- A command fails when you run it: keep it out of the file, or note what it needs (a service, a variable), and report the failure.
- The file comes out over 200 lines: move the longest reference sections to docs/ and link them; cut what the code already says.
- An instruction file in a subdirectory contradicts the root one: report both lines and ask which holds; do not pick one silently.`;

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: 'init',
    description: "Write the repository's AGENTS.md (or CLAUDE.md), or trim one that is too long: the commands that confirm work, the code's traps and the decisions it does not show, under 200 lines. Use to set up agent instructions in a new repository or to clean up an old file.",
    argumentHint: '[what to focus on]',
    text: INIT,
  },
];
