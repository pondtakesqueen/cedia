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
// Heredoc bodies are data, except for the $( ) and backtick substitutions an unquoted delimiter lets run.
// Returns null for unbalanced quotes or substitutions.
export function simpleCommands(command: string): string[][] | null {
  const out: string[][] = [];
  const fromHeredocs: string[][] = [];
  const heredocs: { delim: string; quoted: boolean; dash: boolean }[] = [];
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
    } else if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      endWord();
      const head = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(command.slice(i));
      if (!head) return null;
      const delim = head[2] ?? head[3] ?? head[4]!;
      heredocs.push({ delim, quoted: head[4] === undefined || head[0].includes('\\'), dash: head[1] === '-' });
      i += head[0].length - 1;
    } else if (ch === '\n' && heredocs.length) {
      endCommand();
      // Bodies start on the next line, one after another, each ended by a line that is its delimiter.
      for (const h of heredocs.splice(0)) {
        let body = '';
        while (i + 1 < command.length) {
          const end = command.indexOf('\n', i + 1);
          const line = command.slice(i + 1, end < 0 ? command.length : end);
          i = end < 0 ? command.length : end;
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim) break;
          body += line + '\n';
        }
        if (!h.quoted) {
          const subs = substitutions(body);
          if (!subs) return null;
          for (const sub of subs) {
            const inner = simpleCommands(sub);
            if (!inner) return null;
            fromHeredocs.push(...inner);
          }
        }
      }
    } else if (SEPARATORS.has(ch) || (ch === '$' && command[i + 1] === '(')) {
      endCommand();
    } else if (/\s/.test(ch)) {
      endWord();
    } else cur += ch;
  }
  if (quote) return null;
  endCommand();
  return [...out.flatMap(expand), ...fromHeredocs];
}

// The $( ) and backtick substitutions in text the shell expands (an unquoted heredoc body). Null when one is
// not closed.
function substitutions(text: string): string[] | null {
  const subs: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) return null;
      subs.push(text.slice(i + 1, end));
      i = end;
    } else if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')' && --depth === 0) break;
      }
      if (j >= text.length) return null;
      subs.push(text.slice(i + 2, j));
      i = j;
    }
  }
  return subs;
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
