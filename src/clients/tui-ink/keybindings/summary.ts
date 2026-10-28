import type { Binding } from './types.ts';

// Words for the commands a keybindings.json may rebind, for the line /help prints.
const COMMAND_WORDS: Record<string, string> = {
  cancel: 'cancel',
  submit: 'send',
  historyUp: 'previous prompt',
  historyDown: 'next prompt',
  autocomplete: 'complete',
  historySearch: 'search prompts',
};

// The person's own bindings as "key what" pairs, or '' when there are none.
export function bindingSummary(bindings: Binding[]): string {
  return bindings
    .map((b) => `${b.key} ${COMMAND_WORDS[b.command] ?? b.command}`)
    .join(' · ');
}
