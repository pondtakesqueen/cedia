// cedia puts text it did not write (a sub-thread's report, another thread's message, a handoff note, a plan, a
// review, a diff) inside tags that tell the model where that text starts and ends. Text that holds one of those
// tags could close its frame early and speak as cedia after it, so the tags inside are made inert (`<` becomes
// `&lt;`), and characters that hide or reorder text on screen (tag characters, bidi overrides) are dropped.
export const FRAME_TAGS = ['subthread', 'message', 'handoff', 'result', 'task', 'plan', 'review', 'diff', 'environment', 'user_context', 'project_instructions', 'project_memory', 'skills'];

const TAG = new RegExp(`<(/?)(${FRAME_TAGS.join('|')})(?=[\\s>/]|$)`, 'gi');
const HIDDEN = /[\u{E0000}-\u{E007F}‪-‮⁦-⁩]/gu;

export const inert = (text: string): string => text.replace(HIDDEN, '').replace(TAG, '&lt;$1$2');
