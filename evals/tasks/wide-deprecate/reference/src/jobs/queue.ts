import { log, type Level } from '../log.ts';

// jobs/queue: the queue step.
export function run(level: Level = "warn"): void {
  log.at(level, 'queue drained');
}
