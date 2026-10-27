import type { Question } from '../../core/types.ts';

// The text a run that ended asking shows: the writer's question with its options, answered by the next prompt.
export function askedBannerText(q: Question): string {
  return `? ${q.question}${q.options?.length ? `\n${q.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}` : ''}\nanswer with your next prompt`;
}
