// Remote control (minimal). A remote cedia exposes a small JSON API; this client lists and resumes sessions.
// Cloud/teleport features are not implemented; this is a thin adapter over fetch.

export type RemoteSession = { id: string; title?: string; cwd?: string; updatedAt?: string };

export function remoteUrl(): string | undefined {
  return process.env.CEDIA_REMOTE_URL;
}

export async function listRemoteSessions(url = remoteUrl()): Promise<RemoteSession[]> {
  if (!url) return [];
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/sessions`);
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
    const res = await fetch(`${url.replace(/\/$/, '')}/sessions/${encodeURIComponent(id)}`);
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) return `remote error ${res.status}`;
    const data = (await res.json()) as { output?: string; result?: string };
    return data.output ?? data.result ?? '(no output)';
  } catch (e) {
    return `remote failed: ${(e as Error).message}`;
  }
}
