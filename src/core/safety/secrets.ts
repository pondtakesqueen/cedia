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
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g, // OpenAI, DeepSeek and other sk- keys
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bgl(?:pat|dt|rt|oas|ptt|agent|imt|soat|cbt|ft|ffct)-[A-Za-z0-9_.-]{20,}/g, // GitLab token families; routable ones carry dots
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

// The password in `scheme://user:password@host`, up to the last @ before the host, so a password that holds an
// @ goes whole.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:)([^\s/?#]{3,})@/g;

// The credential after `Bearer` or `Basic`, as in an Authorization header. Prose (`Bearer authentication`) has
// no digit and no mixed case.
const AUTH_SCHEME = /\b(Bearer|Basic)([ \t]+)([A-Za-z0-9._~+/-]{12,}=*)/g;

// `NAME=value`, `name: value`, `"name": "value"` and `NAME = "value"` where the name says secret. Names are at
// most 64 characters: an unbounded name made long runs (`a.a.a.…`, minified code) take quadratic time.
// Invisible characters inside a name (a zero-width space in API_KEY) do not hide it.
const ASSIGNMENT = /\b([A-Za-z0-9_.\-\u00AD\u200B-\u200D\u2060\uFEFF]{1,64})(["']?[ \t]*[:=][ \t]*)(["'`]?)([^\s"'`,;]+)\3/g;
const SECRET_NAME = /api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|credentials?/i;
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

// Which assigned values count as secrets, so code that only names a secret (`password: hash(input)`,
// `token = getToken()`) still reads as written:
// - a dotenv line (`export NAME=value` at the start of a line): any value, except a number under a name that
//   is not a password, secret or key (MAX_TOKENS=4096 is a setting; DB_PASSWORD=12345678 is not);
// - a quoted value: 4+ characters for passwords and secrets, otherwise 8+ with a letter and a digit;
// - any other value: 8+ characters with a letter and a digit, and no call or member access.
function secretValue(kind: string, quote: string, value: string, dotenv: boolean): boolean {
  if (/^(\$|process\.|os\.|env\.|getenv|none$|null$|undefined$|true$|false$)/i.test(value)) return false; // a reference
  const tokenLike = value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value);
  if (dotenv) return !/^\d+$/.test(value) || /passw|pwd|secret|key|credential/i.test(kind);
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
    return `${head}${REDACTED}@`;
  });
  out = out.replace(AUTH_SCHEME, (match, scheme: string, space: string, value: string) => {
    if (!/\d/.test(value) && !(/[a-z]/.test(value) && /[A-Z]/.test(value) && value.length >= 16)) return match;
    count++;
    return `${scheme}${space}${REDACTED}`;
  });
  out = out.replace(ASSIGNMENT, (match, name: string, sep: string, quote: string, value: string, offset: number, all: string) => {
    if (value.includes(REDACTED)) return match;
    const clean = name.replace(INVISIBLE, '');
    const kind = SECRET_NAME.exec(clean)?.[0];
    if (!kind) return match;
    const lineStart = all.lastIndexOf('\n', offset - 1) + 1;
    const dotenv = sep === '=' && /^[ \t]*(export[ \t]+)?$/.test(all.slice(lineStart, offset)) && /^[A-Z0-9_]+$/.test(clean);
    if (!secretValue(kind, quote, value, dotenv)) return match;
    count++;
    return `${name}${sep}${quote}${REDACTED}${quote}`;
  });
  return { text: out, count };
}
