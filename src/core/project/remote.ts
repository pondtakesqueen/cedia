// Remote control (minimal). A remote cedia exposes a small JSON API; this client lists and resumes sessions.
// Cloud/teleport features are not implemented; this is a thin adapter over fetch.

export type RemoteSession = { id: string; title?: string; cwd?: string; updatedAt?: string };

export function remoteUrl(): string | undefined {
  return process.env.CEDIA_REMOTE_URL;
}

// `cedia serve` answers only a request with its token (CEDIA_REMOTE_TOKEN here).
function auth(): Record<string, string> {
  const t = process.env.CEDIA_REMOTE_TOKEN;
  return t ? { authorization: `Bearer ${t}` } : {};
}

export async function listRemoteSessions(url = remoteUrl()): Promise<RemoteSession[]> {
  if (!url) return [];
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/sessions`, { headers: auth() });
    if (!res.ok) return [];
    const data = (await res.json()) as { sessions?: RemoteSession[] } | RemoteSession[];
    return Array.isArray(data) ? data : (data.sessions ?? []);
  } catch {
    return [];
  }
}

export async function fetchRemoteSession(id: string, url = remoteUrl()): Promise<RemoteSession | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/sessions/${encodeURIComponent(id)}`, { headers: auth() });
    if (!res.ok) return undefined;
    return (await res.json()) as RemoteSession;
  } catch {
    return undefined;
  }
}

export async function runRemote(prompt: string, url = remoteUrl()): Promise<string> {
  if (!url) return 'CEDIA_REMOTE_URL not set';
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth() },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) return `remote error ${res.status}`;
    const data = (await res.json()) as { output?: string; result?: string };
    return data.output ?? data.result ?? '(no output)';
  } catch (e) {
    return `remote failed: ${(e as Error).message}`;
  }
}
