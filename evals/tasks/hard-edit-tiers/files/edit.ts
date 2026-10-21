export type TextEdit = { old_text: string; new_text: string; replace_all?: boolean };
export type Tier = 'exact' | 'trailing-space' | 'indentation';
// from/to are 1-based line numbers of the replaced text in the original content; count is how many places were replaced.
export type Applied = { from: number; to: number; tier: Tier; count: number };

// Applies one edit to `content`.
//
// Tiers, tried in order; a tier applies only when it finds exactly one place (or replace_all is set, exact tier only):
// 1. exact: old_text appears verbatim. With several matches and no replace_all, it is an error naming the count
//    and the line of the first match. With replace_all every occurrence is replaced.
// 2. trailing-space: compare whole lines of old_text (a single trailing newline on old_text/new_text is ignored)
//    against windows of lines in content, ignoring trailing whitespace on each line. The matched lines are replaced
//    by new_text's lines as given.
// 3. indentation: like 2 but ignoring leading and trailing whitespace. new_text is re-indented: the indentation of
//    old_text's first non-blank line is swapped for the indentation of the matched window's first non-blank line,
//    on every non-blank line of new_text. An empty new_text deletes the lines.
// More than one match in tier 2 or 3 is an error naming the count and the 1-based lines.
//
// Errors (returned as { error }, never thrown):
// - empty old_text: message contains "use write"
// - old_text === new_text: message contains "same"
// - several matches: message contains "matches N places"
// - nothing matched: message contains "not found", and when the first non-blank line of old_text (trimmed) occurs
//   in some lines of content, "first line appears at line L1, L2" (at most 5 lines).
export function applyEdit(content: string, edit: TextEdit): { content: string; applied: Applied } | { error: string } {
  throw new Error('not implemented');
}
