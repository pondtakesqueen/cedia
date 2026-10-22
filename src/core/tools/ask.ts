import type { Question } from '../types.ts';
import type { ToolSpec } from './registry.ts';

// ask_user: the writer ends its run with one question for the owner, and the thread waits until they answer (the
// answer is the next prompt of the thread). cedia still never pauses a run to ask for approval: a policy decides
// every call. This is for the rare question only the owner can answer, so the description keeps the bar high.
// Present only when the client asks for it (`--ask on`, `ask` in settings), on a writer session of a thread.

export const ASK_TOOL = 'ask_user';
export const MAX_OPTIONS = 4;

export function questionOf(input: Record<string, unknown>): Question | string {
  const question = String(input.question ?? '').trim();
  if (!question) return 'question is required';
  const raw = input.options;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((o) => typeof o !== 'string' || !o.trim()))) return 'options must be a list of non-empty strings';
  const options = (raw as string[] | undefined)?.map((o) => o.trim());
  if (options && (options.length < 2 || options.length > MAX_OPTIONS)) return `give 2 to ${MAX_OPTIONS} options, or none`;
  return { question, ...(options ? { options } : {}) };
}

// The prompt that resumes an asking thread: the question it asked, then the owner's answer.
export const answerPrompt = (question: string, answer: string) => `You asked the owner:\n\n<question>\n${question}\n</question>\n\nTheir answer:\n\n${answer}`;

export const askTool: ToolSpec = {
  name: ASK_TOOL,
  description: `Ask the owner one question and end this run; the thread waits until they answer, and the answer arrives as the next message. The owner wants threads to keep working and check their own work, so ask only when the work truly cannot go on well without them:

- a decision that changes what the task is for, or that picks between outcomes they would care about and you cannot infer from the task, the repository or the context;
- a step that cannot be undone or costs real money, beyond what the task already asked for;
- something only they have: a credential, an account, a fact about the world outside the repository.

Everything else, decide yourself and keep going: pick the most likely reading of an ambiguous task, choose between reasonable designs, fix what you broke, work around a missing tool, and say in your final report what you chose and why. Never ask for permission to run checks, edit files or continue, and never ask a question the code or the docs answer. Before you ask, finish the parts of the task that do not depend on the answer. Write the question so it can be answered without reading this session: the decision, why it matters, and your recommendation.`,
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The decision, why it matters, and what you recommend' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: MAX_OPTIONS, description: 'Short answers to pick from, recommended one first; leave out for an open question' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  effect: 'read',
  replay: 'safe',
  async run(input) {
    const q = questionOf(input);
    if (typeof q === 'string') return { text: q, isError: true };
    return { text: 'Asked. This run ends after this turn; the owner\'s answer will arrive as the next message of this thread.', isError: false };
  },
};
