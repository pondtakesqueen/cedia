export type WalkBand =
  | { kind: 'chrome'; rows: number }
  | { kind: 'message'; index: number; rows: number };

export type RowSpan = { index: number; row: number; height: number };

export type RowHit = { index: number; rowInSpan: number };

export type RowMap = {
  readonly spans: readonly RowSpan[];
  rowAt(termRow: number): RowHit | undefined;
};

/**
 * Bands run from the top of the terminal downward.
 * A span's row is the sum of rows of every band before that message.
 * Chrome advances the cursor and adds no span. A message with rows below 1 counts as 1.
 * rowAt returns undefined on chrome and outside the walk.
 * height on a span is that band's rows for this frame only.
 */
export function rowMapFromWalk(bands: readonly WalkBand[]): RowMap {
  const spans: RowSpan[] = [];
  let cursor = 0;
  for (const band of bands) {
    if (band.kind === 'chrome') {
      cursor += Math.max(0, band.rows);
      continue;
    }
    const height = Math.max(1, band.rows);
    spans.push({ index: band.index, row: cursor, height });
    cursor += height;
  }
  return {
    spans,
    rowAt(termRow: number): RowHit | undefined {
      if (!Number.isFinite(termRow)) return undefined;
      for (const span of spans) {
        if (termRow >= span.row && termRow < span.row + span.height) {
          return { index: span.index, rowInSpan: termRow - span.row };
        }
      }
      return undefined;
    },
  };
}

export type InkSelection = { aMsg: number; aCol: number; bMsg: number; bCol: number };

/**
 * Half-open slice of displayMessages[index] for this selection, or undefined when index is outside it.
 * Indexes are displayMessages indexes, the same numbers WalkBand message bands carry.
 */
export function selectionBounds(
  sel: InkSelection,
  index: number,
  textLength: number,
): { start: number; end: number } | undefined {
  const len = Math.max(0, textLength);
  const forward = sel.aMsg <= sel.bMsg;
  const earlier = forward ? { msg: sel.aMsg, col: sel.aCol } : { msg: sel.bMsg, col: sel.bCol };
  const later = forward ? { msg: sel.bMsg, col: sel.bCol } : { msg: sel.aMsg, col: sel.aCol };
  if (index < earlier.msg || index > later.msg) return undefined;
  const clamp = (n: number) => Math.max(0, Math.min(len, n));
  if (earlier.msg === later.msg) {
    const start = clamp(Math.min(sel.aCol, sel.bCol));
    const end = clamp(Math.max(sel.aCol, sel.bCol) + 1);
    return { start, end };
  }
  if (index === earlier.msg) return { start: clamp(earlier.col), end: len };
  if (index === later.msg) return { start: 0, end: clamp(later.col + 1) };
  return { start: 0, end: len };
}

export type CancelStep = 'abort-turn' | 'close-overlay' | 'clear-input' | 'exit';

/**
 * Shared by the ctrl+c prefix and a Chat binding whose command is cancel.
 * running wins, including when an overlay is open. The overlay stays up and the turn stops.
 * Otherwise an overlay closes and the draft stays.
 * Otherwise a non-empty draft clears.
 * Otherwise the process exits.
 * Trust does not call this. The trust gate returns first, and ctrl+c there still does nothing.
 */
export function cancelStep(s: { running: boolean; overlay: boolean; editorEmpty: boolean }): CancelStep {
  if (s.running) return 'abort-turn';
  if (s.overlay) return 'close-overlay';
  if (!s.editorEmpty) return 'clear-input';
  return 'exit';
}

/**
 * scrollOffset that puts displayMessages[index] at the bottom of the window the paint walk already uses.
 * heightEnd = count - scrollOffset, so the offset is count - 1 - index.
 * Clamp index into the list. An empty list returns 0.
 */
export function offsetForIndex(count: number, index: number): number {
  if (count <= 0) return 0;
  const i = Math.max(0, Math.min(count - 1, index));
  return count - 1 - i;
}
