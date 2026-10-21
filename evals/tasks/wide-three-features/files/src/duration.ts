// Durations as text, for config files and logs.
//
// parseDuration: one or more <number><unit> parts, optionally separated by spaces: "90s", "1h30m", "1.5h",
// "2d 4h", "250ms". Spaces around the whole text are ignored. Units: d, h, m, s, ms. Numbers may have a
// fraction. Returns milliseconds, rounded to a whole number. Throws an Error whose message contains the input
// for anything else: "", "10", "5x", "h", "-1s".
//
// formatDuration: milliseconds to the shortest text using d, h, m, s and ms, largest unit first, zero parts
// left out, no spaces: 5_400_000 -> "1h30m", 1_500 -> "1s500ms", 0 -> "0s". Throws on a negative number.
export function parseDuration(text: string): number {
  throw new Error('not implemented');
}

export function formatDuration(ms: number): string {
  throw new Error('not implemented');
}
