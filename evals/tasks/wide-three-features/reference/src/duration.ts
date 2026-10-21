const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };

export function parseDuration(text: string): number {
  const s = text.trim();
  const part = /(\d+(?:\.\d+)?)(ms|d|h|m|s)\s*/y;
  let total = 0;
  let i = 0;
  if (!s) throw new Error(`not a duration: "${text}"`);
  while (i < s.length) {
    part.lastIndex = i;
    const m = part.exec(s);
    if (!m) throw new Error(`not a duration: "${text}"`);
    total += Number(m[1]) * UNITS[m[2]!]!;
    i = part.lastIndex;
  }
  return Math.round(total);
}

export function formatDuration(ms: number): string {
  if (ms < 0) throw new Error(`negative duration: ${ms}`);
  if (ms === 0) return '0s';
  let left = Math.round(ms);
  let out = '';
  for (const [unit, size] of Object.entries(UNITS)) {
    const n = Math.floor(left / size);
    if (n) out += `${n}${unit}`;
    left -= n * size;
  }
  return out;
}
