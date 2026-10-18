export interface CompactionTracker {
  lastCompactTurn: number;
  consecutiveRapidRefills: number;
  turnCounter: number;
}

export function emptyCompactionTracker(): CompactionTracker {
  return { lastCompactTurn: -10, consecutiveRapidRefills: 0, turnCounter: 0 };
}

export function onTurnStart(tracker: CompactionTracker): void {
  tracker.turnCounter++;
}
export function shouldCompact(tracker: CompactionTracker): { allow: boolean; reason?: string } {
  const turnsSinceLast = tracker.turnCounter - tracker.lastCompactTurn;
  if (turnsSinceLast < 3 && tracker.consecutiveRapidRefills >= 1) {
    return { allow: false, reason: "Autocompact is thrashing — context refills too quickly. Try reading in smaller chunks, or use /clear." };
  }
  return { allow: true };
}

export function onCompact(tracker: CompactionTracker): void {
  const turnsSinceLast = tracker.turnCounter - tracker.lastCompactTurn;
  if (turnsSinceLast < 3) {
    tracker.consecutiveRapidRefills++;
  } else {
    tracker.consecutiveRapidRefills = 0;
  }
  tracker.lastCompactTurn = tracker.turnCounter;
}