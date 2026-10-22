import type { AttemptError, AttemptErrorCode, ModelSpec } from '../types.ts';
import { processKeychain, type Keychain } from './keychain.ts';
import { VERSION } from '../version.ts';

export const USER_AGENT = `cedia/${process.env.CEDIA_VERSION ?? VERSION}`;

type Env = Record<string, string | undefined>;

// The environment first, then the Keychain under the same names (core/providers/keychain.ts). A caller that passes
// its own env gets no Keychain unless it passes one too, so tests never read the real one.
export function authKey(model: ModelSpec, env: Env = process.env, keychain: Keychain | undefined = env === process.env ? processKeychain() : undefined): string | undefined {
  const names = [model.auth.env, ...(model.auth.altEnv ? [model.auth.altEnv] : [])];
  for (const n of names) if (env[n]) return env[n];
  if (model.wire === 'faux' || !keychain) return undefined;
  for (const n of names) {
    const key = keychain(n);
    if (key) return key;
  }
  return undefined;
}

export function authHeaders(model: ModelSpec, env: Env = process.env, keychain?: Keychain): Record<string, string> {
  const key = keychain ? authKey(model, env, keychain) : authKey(model, env);
  if (!key) return {};
  return model.auth.scheme === 'x-api-key' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` };
}

// Credentials may also be added by an egress proxy (cloud network secrets), so a missing key is a note, not an error.
export function missingKeyNote(model: ModelSpec, env: Env = process.env, keychain?: Keychain): string | undefined {
  if (model.wire === 'faux' || (keychain ? authKey(model, env, keychain) : authKey(model, env))) return undefined;
  const names = model.auth.altEnv ? `${model.auth.env} (or ${model.auth.altEnv})` : model.auth.env;
  return `cedia: ${names} is not set${process.platform === 'darwin' ? ' or in the Keychain' : ''}; sending ${model.ref} requests without credentials, expecting a proxy to add them`;
}

// A spent plan or balance, told apart from a per-minute rate limit by its message.
const QUOTA = /quota|insufficient[ _](balance|credit|funds)|usage limit|limit reached|billing|out of credits/;
// A 429 that says to come back later than this is a spent plan window, not a per-minute limit: Go's free tier
// answered "Rate limit exceeded" with retry-after 27380 s (7.6 h), and a session slept on it.
const QUOTA_WAIT_MS = 10 * 60_000;

const RETRYABLE: AttemptErrorCode[] = ['rate_limit', 'overloaded', 'network', 'timeout', 'server'];
export const isRetryable = (e: AttemptError) => RETRYABLE.includes(e.code);

export function classifyStatus(status: number, body: string, retryAfter?: string | null): AttemptError {
  const retryAfterMs = parseRetryAfter(retryAfter);
  const message = body.slice(0, 2000) || `HTTP ${status}`;
  const lower = body.toLowerCase();
  let code: AttemptErrorCode;
  if (status === 402 || (status === 429 && (QUOTA.test(lower) || (retryAfterMs ?? 0) > QUOTA_WAIT_MS))) code = 'quota';
  else if (status === 429) code = 'rate_limit';
  else if (status === 529 || lower.includes('overloaded')) code = 'overloaded';
  else if (status === 401 || status === 403) code = 'auth';
  else if (status === 408) code = 'timeout';
  else if (status >= 500) code = 'server';
  else if (/context.{0,20}(length|window)|too long|maximum context|prompt is too long/.test(lower)) code = 'context_length';
  else code = 'bad_request';
  return { code, status, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

function parseRetryAfter(v?: string | null): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

export function networkError(err: unknown): AttemptError {
  const message = err instanceof Error ? err.message : String(err);
  const code: AttemptErrorCode = /timed? ?out|timeout/i.test(message) ? 'timeout' : 'network';
  return { code, message };
}

// Error the provider reported inside an otherwise-200 stream.
export function classifyStreamError(type: string | undefined, message: string): AttemptError {
  const t = (type ?? '').toLowerCase();
  if (QUOTA.test(t) || QUOTA.test(message.toLowerCase())) return { code: 'quota', message };
  if (t.includes('overloaded')) return { code: 'overloaded', message };
  if (t.includes('rate')) return { code: 'rate_limit', message };
  if (t.includes('auth') || t.includes('permission')) return { code: 'auth', message };
  if (t.includes('invalid') || t.includes('request')) return { code: 'bad_request', message };
  return { code: 'server', message };
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<{ ok: true; body: ReadableStream<Uint8Array> } | { ok: false; error: AttemptError }> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, error: networkError(err) };
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: classifyStatus(res.status, text, res.headers.get('retry-after')) };
  }
  return { ok: true, body: res.body };
}
