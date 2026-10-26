export async function fetchMdmSettings(url = process.env.CEDIA_MDM_URL): Promise<Record<string, unknown>> {
  if (!url) return {};
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
