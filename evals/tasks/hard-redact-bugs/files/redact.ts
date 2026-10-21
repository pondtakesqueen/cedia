import { homedir } from 'node:os';
import { join } from 'node:path';

// Credential stores no tool may read: the sandbox denies them to bash, the policy denies them to read and to
// bash words that name them, so their contents never reach a model provider.
export function secretPaths(cediaHome: string, home = homedir()): string[] {
  return ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.docker/config.json', '.git-credentials', '.npmrc', '.pypirc', '.kube/config']
    .map((p) => join(home, p))
    .concat(cediaHome);
}

// What a redacted value is replaced with. Edits and commands that contain it are denied, so a model that only
// saw the placeholder cannot write it back over the real secret.
export const REDACTED = '[cedia:redacted]';

// Token formats with a fixed prefix. The generic ones need a digit so prose and identifiers do not match.
const TOKENS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, DeepSeek and other sk- keys
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

// The password in `scheme://user:password@host`.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})@/g;

// `NAME=value`, `name: value`, `"name": "value"` and `NAME = "value"` where the name says secret.
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*?(api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|credentials?)[A-Za-z0-9_.-]*)(["']?[ \t]*[:=][ \t]*)(["'`]?)([^\s"'`,;]+)\4/gi;

// Which assigned values count as secrets, so code that only names a secret (`password: hash(input)`,
// `token = getToken()`) still reads as written:
// - a dotenv line (`export NAME=value` at the start of a line): any value;
// - a quoted value: 4+ characters for passwords and secrets, otherwise 8+ with a letter and a digit;
// - any other value: 8+ characters with a letter and a digit, and no call or member access.
function secretValue(kind: string, quote: string, value: string, dotenv: boolean): boolean {
  if (/^(\$|process\.|os\.|env\.|getenv|none$|null$|undefined$|true$|false$)/i.test(value)) return false; // a reference
  const tokenLike = value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value);
  if (dotenv) return true;
  if (quote) return /passw|pwd|secret/i.test(kind) ? value.length >= 4 : tokenLike;
  return tokenLike && !/[().[\]]/.test(value);
}

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of TOKENS)
    out = out.replace(re, () => {
      count++;
      return REDACTED;
    });
  out = out.replace(URL_PASSWORD, (_m, head: string, password: string) => {
    if (password === REDACTED) return _m;
    count++;
    return `${head}${REDACTED}`;
  });
  out = out.replace(ASSIGNMENT, (match, name: string, kind: string, sep: string, quote: string, value: string, offset: number, all: string) => {
    if (value.includes(REDACTED)) return match;
    const lineStart = all.lastIndexOf('\n', offset - 1) + 1;
    const dotenv = sep === '=' && /^[ \t]*(export[ \t]+)?$/.test(all.slice(lineStart, offset)) && /^[A-Z0-9_]+$/.test(name);
    if (!secretValue(kind, quote, value, dotenv)) return match;
    count++;
    return `${name}${sep}${quote}${REDACTED}${quote}`;
  });
  return { text: out, count };
}
