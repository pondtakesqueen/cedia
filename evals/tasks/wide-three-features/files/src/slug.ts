// URL slugs for titles.
//
// slugify(text, max?):
// - lower case;
// - a letter with an accent or other diacritic loses it (à -> a, ç -> c, ñ -> n, ź -> z, and so on);
//   ß -> ss, æ -> ae, œ -> oe, ø -> o, ł -> l, đ -> d;
// - any other character that is not a-z or 0-9 is a separator; runs of separators become one "-", and the slug
//   never starts or ends with "-";
// - with max, a slug longer than max is cut at the last "-" that keeps it within max (no dangling "-"), or at
//   max itself when there is no "-" to cut at. A "-" right after the first max characters counts: cutting there
//   keeps exactly max ("ab-cd-ef" with max 5 is "ab-cd").
//
// uniqueSlug(slug, taken): slug itself if it is not in taken, else slug-2, slug-3, ... the first free one.
export function slugify(text: string, max?: number): string {
  throw new Error('not implemented');
}

export function uniqueSlug(slug: string, taken: Set<string>): string {
  throw new Error('not implemented');
}
