// Best-effort shell reading for the permission policy. It is not a shell parser: it splits a command
// into simple commands so a rule can look at each one's argv. The sandbox is the real boundary.

const SEPARATORS = new Set([';', '\n', '&', '|', '(', ')', '`']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'nice', 'xargs', 'doas']);
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
      i++;
      while (i < argv.length && argv[i]!.startsWith('-')) i++;
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
