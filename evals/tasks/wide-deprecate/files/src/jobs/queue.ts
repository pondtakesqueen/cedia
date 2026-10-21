import { oldLog, type Level } from '../log.ts';

// jobs/queue: the queue step.
export function run(level: Level = "warn"): void {
  oldLog(level, 'queue drained');
}
