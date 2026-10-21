// Best-effort shell reading for the permission policy. It is not a shell parser: it splits a command
// into simple commands so a rule can look at each one's argv. The sandbox is the real boundary.

const SEPARATORS = new Set([';', '\n', '&', '|', '(', ')', '`']);
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
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until']);

// Splits on ; & | && || newlines, subshells, $( ) and backticks outside quotes, then into words.
// Returns null for unbalanced quotes.
export function simpleCommands(command: string): string[][] | null {
  const out: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (cur || has) words.push(cur);
    cur = '';
    has = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i];
    } else if (ch === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
      cur += ch; // 2>&1 and &> are redirections, not background jobs
    } else if (SEPARATORS.has(ch) || (ch === '$' && command[i + 1] === '(')) {
      endCommand();
    } else if (/\s/.test(ch)) {
      endWord();
    } else cur += ch;
  }
  if (quote) return null;
  endCommand();
  return out.flatMap(expand);
}

// Drops redirections, leading assignments and wrappers like sudo or env, and unpacks `bash -c "..."` and eval.
function expand(words: string[]): string[][] {
  const argv: string[] = [];
  for (let j = 0; j < words.length; j++) {
    const w = words[j]!;
    if (/^\d*(<|>>?|&>>?|>&)$/.test(w)) j++; // operator alone: its target is the next word
    else if (!/^\d*(<|>>?|&>>?|>&)/.test(w)) argv.push(w);
  }
  let i = 0;
  while (i < argv.length) {
    const w = argv[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) i++;
    else if (WRAPPERS.has(w)) {
      const wrapper = WRAPPERS.get(w)!;
      i++;
      while (i < argv.length && argv[i]!.startsWith('-')) {
        if (argv[i] === '--') {
          i++;
          break;
        }
        i += wrapper.value?.includes(argv[i]!) ? 2 : 1;
      }
      i += wrapper.positional ?? 0;
    } else break;
  }
  const rest = argv.slice(i);
  const [cmd, ...args] = rest;
  if (!cmd) return [];
  if (/^(ba|z|da|k)?sh$/.test(cmd)) {
    const c = args.indexOf('-c');
    if (c >= 0 && args[c + 1] !== undefined) return simpleCommands(args[c + 1]!) ?? [rest];
  }
  if (cmd === 'eval') return simpleCommands(args.join(' ')) ?? [rest];
  return [rest];
}
