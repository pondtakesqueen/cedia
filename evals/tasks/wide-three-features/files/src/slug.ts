// URL slugs for titles.
//
// slugify(text, max?):
// - lower case;
// - these letters become ASCII: a with any accent (à á â ã ä å) -> a, likewise for e, i, o, u, y, c (ç), n (ñ);
//   ß -> ss, æ -> ae, œ -> oe, ø -> o, ł -> l, đ -> d;
// - any other character that is not a-z or 0-9 is a separator; runs of separators become one "-", and the slug
//   never starts or ends with "-";
// - with max, a slug longer than max is cut at the last "-" that keeps it within max (no dangling "-"), or at
//   max itself when there is no "-" to cut at.
//
// uniqueSlug(slug, taken): slug itself if it is not in taken, else slug-2, slug-3, ... the first free one.
export function slugify(text: string, max?: number): string {
  throw new Error('not implemented');
}

export function uniqueSlug(slug: string, taken: Set<string>): string {
  throw new Error('not implemented');
}
