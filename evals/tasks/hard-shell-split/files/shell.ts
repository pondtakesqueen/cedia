// Commands that run the rest of their argv as another command. `value` lists the flags whose next word is
// their value (`nice -n 5 make` runs make, not 5); `positional` counts operands before the command (`timeout 5 make`).
type Wrapper = { value?: string[]; positional?: number };
const WRAPPERS = new Map<string, Wrapper>([
  ['sudo', { value: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--close-from'] }],
  ['doas', { value: ['-u', '-C'] }],
  ['env', { value: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'] }],
  ['command', {}],
  ['nohup', {}],
  ['time', { value: ['-f', '-o', '--format', '--output'] }],
  ['exec', { value: ['-a'] }],
  ['nice', { value: ['-n', '--adjustment'] }],
  ['ionice', { value: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'] }],
  ['setsid', {}],
  ['stdbuf', { value: ['-i', '-o', '-e', '--input', '--output', '--error'] }],
  ['timeout', { value: ['-s', '-k', '--signal', '--kill-after'], positional: 1 }],
  ['xargs', { value: ['-a', '-d', '-E', '-e', '-I', '-i', '-L', '-l', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var'] }],
]);


// Splits a shell command line into the argv of each simple command, so a permission policy can check every
// command a line would run. It is not a full shell parser; it must never hide a command from the policy.
//
// Rules:
// - Commands are separated by ; & | && || newlines, ( ) subshells, $( ) substitutions and backticks, all outside quotes.
//   The contents of $( ) and backticks are commands of their own.
// - `2>&1`, `>&2` and `&>file` are redirections, not background jobs.
// - Words are split on whitespace outside quotes. Single quotes keep everything literally. In double quotes a
//   backslash escapes the next character. Outside quotes a backslash escapes the next character. Quotes are removed;
//   an empty quoted string ("" or '') is still a word.
// - Redirections are dropped from argv: a word that is only an operator (`>`, `>>`, `<`, `2>`, `&>`, `>&`) drops
//   itself and the next word (its target); a word that starts with one (`>out.txt`, `2>/dev/null`, `2>&1`) drops itself.
// - Leading `NAME=value` assignments and shell keywords ({ } ! if then else elif fi do done while until) are skipped.
// - Wrappers (WRAPPERS below) are unwrapped along with the flags right after them (words starting with -). A flag in
//   the wrapper's `value` list also takes the next word; `--` ends the flags; then `positional` more words are skipped.
// - `bash -c "<script>"` (also sh, zsh, dash, ksh) and `eval <words>` are replaced by the commands of the script.
// - Empty commands are left out.
// - Unbalanced quotes: return null.
export function simpleCommands(command: string): string[][] | null {
  throw new Error('not implemented');
}
