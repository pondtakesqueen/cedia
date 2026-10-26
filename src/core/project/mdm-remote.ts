export async function fetchMdmSettings(url = process.env.CEDIA_MDM_URL, timeoutMs = 3000): Promise<Record<string, unknown>> {
  if (!url) return {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  } finally {
    clearTimeout(t);
  }
}
