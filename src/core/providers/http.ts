import type { AttemptError, AttemptErrorCode, ModelSpec } from '../types.ts';

export const USER_AGENT = `cedia/${process.env.CEDIA_VERSION ?? '0.1.0'}`;

type Env = Record<string, string | undefined>;

export const authKey = (model: ModelSpec, env: Env = process.env): string | undefined =>
  env[model.auth.env] || (model.auth.altEnv ? env[model.auth.altEnv] : undefined) || undefined;

export function authHeaders(model: ModelSpec, env: Env = process.env): Record<string, string> {
  const key = authKey(model, env);
  if (!key) return {};
  return model.auth.scheme === 'x-api-key' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` };
}

// Credentials may also be added by an egress proxy (cloud network secrets), so a missing key is a note, not an error.
export function missingKeyNote(model: ModelSpec, env: Env = process.env): string | undefined {
  if (model.wire === 'faux' || authKey(model, env)) return undefined;
  const names = model.auth.altEnv ? `${model.auth.env} (or ${model.auth.altEnv})` : model.auth.env;
  return `cedia: ${names} is not set; sending ${model.ref} requests without credentials, expecting a proxy to add them`;
}

// A spent plan or balance, told apart from a per-minute rate limit by its message.
const QUOTA = /quota|insufficient[ _](balance|credit|funds)|usage limit|limit reached|billing|out of credits/;

const RETRYABLE: AttemptErrorCode[] = ['rate_limit', 'overloaded', 'network', 'timeout', 'server'];
export const isRetryable = (e: AttemptError) => RETRYABLE.includes(e.code);

export function classifyStatus(status: number, body: string, retryAfter?: string | null): AttemptError {
  const retryAfterMs = parseRetryAfter(retryAfter);
  const message = body.slice(0, 2000) || `HTTP ${status}`;
  const lower = body.toLowerCase();
  let code: AttemptErrorCode;
  if (status === 402 || (status === 429 && QUOTA.test(lower))) code = 'quota';
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
