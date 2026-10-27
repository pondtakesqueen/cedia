// Pure formatting helpers for the settings overlay (cc-style rows).

// Humanize a settings key the way cc labels its rows ("cacheTtl" → "Cache TTL").
export function humanizeSettingKey(k: string): string {
  const spaced = k.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bTtl\b/g, 'TTL').replace(/\bLsp\b/g, 'LSP').replace(/\bMcp\b/g, 'MCP')
    .replace(/\bApi\b/g, 'API').replace(/\bUrl\b/g, 'URL').replace(/\bId\b/g, 'ID');
}

// Display text for a settings value; objects/arrays get a cc-style `›` submenu marker.
export function settingDisplayValue(v: unknown): { text: string; submenu: boolean } {
  if (v !== null && typeof v === 'object') {
    const summary = Array.isArray(v) ? `${v.length} items` : `${Object.keys(v).length} keys`;
    return { text: `${summary} ›`, submenu: true };
  }
  return { text: JSON.stringify(v) ?? '', submenu: false };
}
