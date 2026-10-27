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
