const SPECIAL: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd' };

export function slugify(text: string, max?: number): string {
  const ascii = [...text.toLowerCase()]
    .map((ch) => SPECIAL[ch] ?? ch.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
    .join('');
  let slug = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (max !== undefined && slug.length > max) {
    const cut = slug.slice(0, max + 1).lastIndexOf('-');
    slug = cut > 0 ? slug.slice(0, cut) : slug.slice(0, max);
    slug = slug.replace(/-+$/, '');
  }
  return slug;
}

export function uniqueSlug(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
}
